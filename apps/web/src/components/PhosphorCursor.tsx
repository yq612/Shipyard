import { useLayoutEffect } from "react";
import arrow from "../assets/cursors/cursor-minimal.svg?raw";
import pointer from "../assets/cursors/pointer.svg?raw";

const PROPERTIES = ["--cursor-image-default", "--cursor-image-pointer"] as const;

function cursorImage(source: string, ink: string, edge: string, hotspot: string, fallback: "auto" | "pointer") {
  // 先画底色描边，指针在反显的绿按钮上也看得清。
  const svg = source.replace(
    'fill="currentColor"',
    `fill="${ink}" stroke="${edge}" stroke-width="2" stroke-linejoin="miter" paint-order="stroke fill" shape-rendering="crispEdges"`,
  );
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot}, ${fallback}`;
}

/** 用 CSS cursor 换指针图片，不监听 mousemove，也不加跟随鼠标的 DOM。 */
export function PhosphorCursor() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      // SVG 图片读不到 CSS 变量，换主题时把算好的颜色写进去。
      const style = getComputedStyle(root);
      const ink = style.getPropertyValue("--c-accent-ink").trim();
      const screen = style.getPropertyValue("--c-screen").trim();
      if (!ink || !screen) return;
      // 热点：箭尖、食指尖。
      root.style.setProperty(PROPERTIES[0], cursorImage(arrow, ink, screen, "6 4", "auto"));
      root.style.setProperty(PROPERTIES[1], cursorImage(pointer, ink, screen, "8 1", "pointer"));
    };

    sync();
    document.addEventListener("phosphor:themechange", sync);
    return () => {
      document.removeEventListener("phosphor:themechange", sync);
      for (const property of PROPERTIES) root.style.removeProperty(property);
    };
  }, []);

  return null;
}
