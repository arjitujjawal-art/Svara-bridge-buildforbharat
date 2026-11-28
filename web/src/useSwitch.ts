import { useEffect } from "react";

export function useSwitch(enabled: boolean, speed: number) {
  useEffect(() => {
    if (!enabled) return;
    let active: HTMLButtonElement | null = null;
    function advance() {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("main button[data-scan]:enabled")];
      const index = active ? buttons.indexOf(active) : -1;
      active?.classList.remove("scan");
      active = buttons[(index + 1) % buttons.length] ?? null;
      active?.classList.add("scan");
    }
    function activate(event: KeyboardEvent) {
      if (event.code !== "Space" || (event.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      event.preventDefault();
      if (!event.repeat && active?.isConnected && !active.disabled) active.click();
    }
    advance();
    const timer = window.setInterval(advance, speed);
    window.addEventListener("keydown", activate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", activate);
      active?.classList.remove("scan");
    };
  }, [enabled, speed]);
}
