import { useLayoutEffect, useRef, type ImgHTMLAttributes } from "react";
import { cx } from "./ui";

/**
 * A thumbnail that fades in when it arrives (the "motion and loading" canvas, board 3): put it in a box with a neutral
 * raised background (`bg-raised`), the box keeps its size and its badges from the start, and only the picture moves. A
 * picture the browser already has (its cache) is complete before it is drawn and shows at once, with no fade: the fade
 * is only for what really arrives. Under "reduce motion" it appears without the fade.
 *
 * The opacity is set on the element itself rather than through state: a grid draws hundreds of these, and a load is
 * then no draw of React at all.
 */
export function Thumb({ src, className, onLoad, onError, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const el = useRef<HTMLImageElement>(null);
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
