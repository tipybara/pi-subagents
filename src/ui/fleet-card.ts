import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.js";

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function rightAlign(left: string, right: string, width: number): string {
  const tail = truncateToWidth(right, Math.max(0, width), "…");
  const rightW = visibleWidth(tail);
  const head = truncateToWidth(left, Math.max(0, width - rightW - 1), "…");
  const gap = Math.max(0, width - visibleWidth(head) - rightW);
  return truncateToWidth(head + " ".repeat(gap) + tail, Math.max(0, width), "…");
}

export function boxTop(width: number, title: string, count: string, theme: Theme): string {
  const inner = Math.max(0, width - 2);
  const tail = count ? truncateToWidth(` ${count} ─`, Math.max(0, inner - 4), "…") : "";
  const head = truncateToWidth(`─ ${title} `, Math.max(0, inner - visibleWidth(tail)), "…");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(head) - visibleWidth(tail)));
  return theme.fg("border", "╭") + theme.fg("accent", head) + theme.fg("border", fill)
    + theme.fg("dim", tail) + theme.fg("border", "╮");
}

export function boxRow(width: number, content: string, theme: Theme): string {
  const inner = Math.max(0, width - 4);
  const body = truncateToWidth(content, inner, "…");
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(body)));
  return `${theme.fg("border", "│")} ${body}${pad} ${theme.fg("border", "│")}`;
}

export function boxBottom(width: number, theme: Theme): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}
