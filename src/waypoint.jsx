/* eslint-disable import/prefer-default-export */

import { addEventListener } from 'consolidated-events';
import PropTypes from 'prop-types';
import React from 'react';
import { isForwardRef } from 'react-is';

import computeOffsetPixels from './computeOffsetPixels';
import {
  INVISIBLE, INSIDE, BELOW, ABOVE,
} from './constants';
import debugLog from './debugLog';
import ensureRefIsUsedByChild from './ensureRefIsUsedByChild';
import isDOMElement from './isDOMElement';
import getCurrentPosition from './getCurrentPosition';
import onNextTick from './onNextTick';
import resolveScrollableAncestorProp from './resolveScrollableAncestorProp';

const defaultProps = {
  debug: false,
  scrollableAncestor: undefined,
  children: undefined,
  topOffset: '0px',
  bottomOffset: '0px',
  horizontal: false,
  onEnter() { },
  onLeave() { },
  onPositionChange() { },
  fireOnRapidScroll: true,
};

// Calls a function when you scroll to the element.
export class Waypoint extends React.PureComponent {
  constructor(props) {
    super(props);

    this.refElement = (e) => {
      this._ref = e;

      const { children } = this.props;
      if (children && children.ref && (isDOMElement(children) || isForwardRef(children))) {
        if (typeof children.ref === 'function') {
          children.ref(e);
        } else {
          children.ref.current = e;
        }
      }
    };
  }

  componentDidMount() {
    if (!Waypoint.getWindow()) {
      return;
    }

    // this._ref may occasionally not be set at this time. To help ensure that
    // this works smoothly and to avoid layout thrashing, we want to delay the
    // initial execution until the next tick.
    this.cancelOnNextTick = onNextTick(() => {
      this.cancelOnNextTick = null;
      const { children, debug } = this.props;

      // Berofe doing anything, we want to check that this._ref is avaliable in Waypoint
      ensureRefIsUsedByChild(children, this._ref);

      this._handleScroll = this._handleScroll.bind(this);
      this.scrollableAncestor = this._findScrollableAncestor();

      if (process.env.NODE_ENV !== 'production' && debug) {
        debugLog('scrollableAncestor', this.scrollableAncestor);
      }

      this.scrollEventListenerUnsubscribe = addEventListener(
        this.scrollableAncestor,
        'scroll',
        this._handleScroll,
        { passive: true },
      );

      this.resizeEventListenerUnsubscribe = addEventListener(
        window,
        'resize',
        this._handleScroll,
        { passive: true },
      );

      this._handleScroll(null);
    });
  }

  componentDidUpdate() {
    if (!Waypoint.getWindow()) {
      return;
    }

    if (!this.scrollableAncestor) {
      // The Waypoint has not yet initialized.
      return;
    }

    // The element may have moved, so we need to recompute its position on the
    // page. This happens via handleScroll in a way that forces layout to be
    // computed.
    //
    // We want this to be deferred to avoid forcing layout during render, which
    // causes layout thrashing. And, if we already have this work enqueued, we
    // can just wait for that to happen instead of enqueueing again.
    if (this.cancelOnNextTick) {
      return;
    }

    this.cancelOnNextTick = onNextTick(() => {
      this.cancelOnNextTick = null;
      this._handleScroll(null);
    });
  }

  componentWillUnmount() {
    if (!Waypoint.getWindow()) {
      return;
    }

    if (this.scrollEventListenerUnsubscribe) {
      this.scrollEventListenerUnsubscribe();
    }
    if (this.resizeEventListenerUnsubscribe) {
      this.resizeEventListenerUnsubscribe();
    }

    if (this.cancelOnNextTick) {
      this.cancelOnNextTick();
    }
  }

  /**
   * Traverses up the DOM to find an ancestor container which has an overflow
   * style that allows for scrolling.
   *
   * @return {Object} the closest ancestor element with an overflow style that
   *   allows for scrolling. If none is found, the `window` object is returned
   *   as a fallback.
   */
  _findScrollableAncestor() {
    const {
      horizontal,
      scrollableAncestor,
    } = this.props;

    if (scrollableAncestor) {
      return resolveScrollableAncestorProp(scrollableAncestor);
    }

    let node = this._ref;

    while (node.parentNode) {
      node = node.parentNode;

      if (node === document.body) {
        // We've reached all the way to the root node.
        return window;
      }

      const style = window.getComputedStyle(node);
      const overflowDirec = horizontal
        ? style.getPropertyValue('overflow-x')
        : style.getPropertyValue('overflow-y');
      const overflow = overflowDirec || style.getPropertyValue('overflow');

      if (overflow === 'auto' || overflow === 'scroll') {
        return node;
      }
    }

    // A scrollable ancestor element was not found, which means that we need to
    // do stuff on window.
    return window;
  }

  /**
   * @param {Object} event the native scroll event coming from the scrollable
   *   ancestor, or resize event coming from the window. Will be undefined if
   *   called by a React lifecyle method
   */
  _handleScroll(event) {
    if (!this._ref) {
      // There's a chance we end up here after the component has been unmounted.
      return;
    }

    const bounds = this._getBounds();
    const currentPosition = getCurrentPosition(bounds);
    const previousPosition = this._previousPosition;
    const {
      debug,
      onPositionChange,
      onEnter,
      onLeave,
      fireOnRapidScroll,
    } = this.props;

    if (process.env.NODE_ENV !== 'production' && debug) {
      debugLog('currentPosition', currentPosition);
      debugLog('previousPosition', previousPosition);
    }

    // Save previous position as early as possible to prevent cycles
    this._previousPosition = currentPosition;

    if (previousPosition === currentPosition) {
      // No change since last trigger
      return;
    }

    const callbackArg = {
      currentPosition,
      previousPosition,
      event,
      waypointTop: bounds.waypointTop,
      waypointBottom: bounds.waypointBottom,
      viewportTop: bounds.viewportTop,
      viewportBottom: bounds.viewportBottom,
    };
    onPositionChange.call(this, callbackArg);

    if (currentPosition === INSIDE) {
      onEnter.call(this, callbackArg);
    } else if (previousPosition === INSIDE) {
      onLeave.call(this, callbackArg);
    }

    const isRapidScrollDown = previousPosition === BELOW
      && currentPosition === ABOVE;
    const isRapidScrollUp = previousPosition === ABOVE
      && currentPosition === BELOW;

    if (fireOnRapidScroll && (isRapidScrollDown || isRapidScrollUp)) {
      // If the scroll event isn't fired often enough to occur while the
      // waypoint was visible, we trigger both callbacks anyway.
      onEnter.call(this, {
        currentPosition: INSIDE,
        previousPosition,
        event,
        waypointTop: bounds.waypointTop,
        waypointBottom: bounds.waypointBottom,
        viewportTop: bounds.viewportTop,
        viewportBottom: bounds.viewportBottom,
      });
      onLeave.call(this, {
        currentPosition,
        previousPosition: INSIDE,
        event,
        waypointTop: bounds.waypointTop,
        waypointBottom: bounds.waypointBottom,
        viewportTop: bounds.viewportTop,
        viewportBottom: bounds.viewportBottom,
      });
    }
  }

  _getBounds() {
    const { horizontal, debug } = this.props;
    const {
      left, top, right, bottom,
    } = this._ref.getBoundingClientRect();
    const waypointTop = horizontal ? left : top;
    const waypointBottom = horizontal ? right : bottom;

    let contextHeight;
    let contextScrollTop;
    if (this.scrollableAncestor === window) {
      contextHeight = horizontal ? window.innerWidth : window.innerHeight;
      contextScrollTop = 0;
    } else {
      contextHeight = horizontal ? this.scrollableAncestor.offsetWidth
        : this.scrollableAncestor.offsetHeight;
      contextScrollTop = horizontal
        ? this.scrollableAncestor.getBoundingClientRect().left
        : this.scrollableAncestor.getBoundingClientRect().top;
    }

    if (process.env.NODE_ENV !== 'production' && debug) {
      debugLog('waypoint top', waypointTop);
      debugLog('waypoint bottom', waypointBottom);
      debugLog('scrollableAncestor height', contextHeight);
      debugLog('scrollableAncestor scrollTop', contextScrollTop);
    }

    const { bottomOffset, topOffset } = this.props;
    const topOffsetPx = computeOffsetPixels(topOffset, contextHeight);
    const bottomOffsetPx = computeOffsetPixels(bottomOffset, contextHeight);
    const contextBottom = contextScrollTop + contextHeight;

    return {
      waypointTop,
      waypointBottom,
      viewportTop: contextScrollTop + topOffsetPx,
      viewportBottom: contextBottom - bottomOffsetPx,
    };
  }

  /**
   * @return {Object}
   */
  render() {
    const { children } = this.props;

    if (!children) {
      // We need an element that we can locate in the DOM to determine where it is
      // rendered relative to the top of its context.
      return <span ref={this.refElement} style={{ fontSize: 0 }} />;
    }

    if (isDOMElement(children) || isForwardRef(children)) {
      return React.cloneElement(children, { ref: this.refElement });
    }

    return React.cloneElement(children, { innerRef: this.refElement });
  }
}

if (process.env.NODE_ENV !== 'production') {
  Waypoint.propTypes = {
    children: PropTypes.element,
    debug: PropTypes.bool,
    onEnter: PropTypes.func,
    onLeave: PropTypes.func,
    onPositionChange: PropTypes.func,
    fireOnRapidScroll: PropTypes.bool,
    // eslint-disable-next-line react/forbid-prop-types
    scrollableAncestor: PropTypes.any,
    horizontal: PropTypes.bool,

    // `topOffset` can either be a number, in which case its a distance from the
    // top of the container in pixels, or a string value. Valid string values are
    // of the form "20px", which is parsed as pixels, or "20%", which is parsed
    // as a percentage of the height of the containing element.
    // For instance, if you pass "-20%", and the containing element is 100px tall,
    // then the waypoint will be triggered when it has been scrolled 20px beyond
    // the top of the containing element.
    topOffset: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.number,
    ]),

    // `bottomOffset` is like `topOffset`, but for the bottom of the container.
    bottomOffset: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.number,
    ]),
  };
}

Waypoint.above = ABOVE;
Waypoint.below = BELOW;
Waypoint.inside = INSIDE;
Waypoint.invisible = INVISIBLE;
Waypoint.getWindow = () => {
  if (typeof window !== 'undefined') {
    return window;
  }
  return undefined;
};
Waypoint.defaultProps = defaultProps;
Waypoint.displayName = 'Waypoint';
