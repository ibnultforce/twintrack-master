'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react';

/** How far a press must move before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 5;
/** Each arrow press scrolls this share of the visible width. */
const ARROW_STEP = 0.7;

/**
 * Makes a row that overflows sideways easy to move with a mouse: drag it, use the wheel, or press the arrows at each
 * end. `canScrollLeft` and `canScrollRight` say whether there is more to see, so arrows show only when useful.
 */
export function useScrollRow<Element extends HTMLElement>() {
  const rowRef = useRef<Element>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startScroll: number; hasMoved: boolean } | null>(null);
  // A drag ends with a click on whatever was under the pointer; this swallows that one click.
  const isClickSuppressed = useRef(false);

  const updateArrows = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setCanScrollLeft(row.scrollLeft > 1);
    setCanScrollRight(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    updateArrows();
    // The wheel turns sideways only when the row can move, so the page still scrolls otherwise.
    const handleWheel = (event: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    const resizeObserver = new ResizeObserver(updateArrows);
    resizeObserver.observe(row);
    row.addEventListener('scroll', updateArrows, { passive: true });
    row.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      resizeObserver.disconnect();
      row.removeEventListener('scroll', updateArrows);
      row.removeEventListener('wheel', handleWheel);
    };
  }, [updateArrows]);

  const scrollByStep = (direction: -1 | 1) => {
    const row = rowRef.current;
    row?.scrollBy({ left: direction * row.clientWidth * ARROW_STEP, behavior: 'smooth' });
  };

  const dragHandlers = {
    onPointerDown: (event: PointerEvent<Element>) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !rowRef.current) return;
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: rowRef.current.scrollLeft, hasMoved: false };
    },
    onPointerMove: (event: PointerEvent<Element>) => {
      const current = drag.current;
      const row = rowRef.current;
      if (!current || !row || current.pointerId !== event.pointerId) return;
      const moved = event.clientX - current.startX;
      if (!current.hasMoved && Math.abs(moved) < DRAG_THRESHOLD) return;
      if (!current.hasMoved) {
        current.hasMoved = true;
        row.setPointerCapture(event.pointerId);
        row.classList.add('is-dragging');
      }
      row.scrollLeft = current.startScroll - moved;
    },
    onPointerUp: (event: PointerEvent<Element>) => {
      const current = drag.current;
      drag.current = null;
      if (!current || !rowRef.current) return;
      if (current.hasMoved) {
        isClickSuppressed.current = true;
        rowRef.current.releasePointerCapture(event.pointerId);
        rowRef.current.classList.remove('is-dragging');
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      rowRef.current?.classList.remove('is-dragging');
    },
    onClickCapture: (event: MouseEvent<Element>) => {
      if (!isClickSuppressed.current) return;
      isClickSuppressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { rowRef, canScrollLeft, canScrollRight, scrollByStep, dragHandlers };
}
