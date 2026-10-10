import { useLayoutEffect, useRef, type ImgHTMLAttributes } from "react";
import { THUMB_SIZES, thumbSrcSet } from "./api";
import { cx } from "./ui";

/**
 * A thumbnail that fades in when it arrives (the "motion and loading" canvas, board 3): put it in a box with a neutral
 * raised background (`bg-raised`), the box keeps its size and its badges from the start, and only the picture moves. A
 * picture the browser already has (its cache) is complete before it is drawn and shows at once, with no fade: the fade
 * is only for what really arrives. Under "reduce motion" it appears without the fade.
 *
 * The opacity is set on the element itself rather than through state: a grid draws hundreds of these, and a load is
 * then no draw of React at all.
 *
 * A thumbnail of the library (a thumbUrl) comes in two sizes, and the browser picks the one the tile needs by the width
 * it is laid out at (thumbSrcSet): 256 px for a small tile on a screen of one pixel per point, else 512 px. The width
 * alone says it only where the box has the picture's own shape, or is no taller than 128 px: `large` for any other box
 * (a fixed 3:4 tile, which a landscape picture fills by its height), which then always has the 512 px one.
 */
export function Thumb({ src, large, className, onLoad, onError, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string; large?: boolean }) {
  const el = useRef<HTMLImageElement>(null);
  const set = large ? undefined : thumbSrcSet(src);
  // before the first paint (and again for another picture): hidden only when it is not there yet
  useLayoutEffect(() => {
    const img = el.current;
    if (!img) return;
    img.style.opacity = img.complete ? "" : "0";
  }, [src]);
  // the browser's own "broken picture" says nothing more than the box does, but it is what was shown before: it shows
  const show = () => {
    if (el.current) el.current.style.opacity = "";
  };
  return (
    <img
      ref={el}
      src={src}
      srcSet={set}
      sizes={set && THUMB_SIZES}
      {...rest}
      onLoad={(e) => {
        show();
        onLoad?.(e);
      }}
      onError={(e) => {
        show();
        onError?.(e);
      }}
      className={cx("motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out", className)}
    />
  );
}
