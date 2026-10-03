'use client';

import { useEffect } from 'react';

/** Quanto a página anda por pixel arrastado com o dedo (1 = igual ao nativo). */
const DRAG_FACTOR = 0.6;
/** Fração da velocidade do arrasto que vira embalo ao soltar o dedo. */
const MOMENTUM_FACTOR = 0.5;
/** Quanto do embalo sobra a cada 16ms — menor = para mais rápido. */
const FRICTION = 0.9;
/** Embalo abaixo disso (px/ms) para de vez. */
const MIN_VELOCITY = 0.02;
/** Movimento mínimo antes de assumir o gesto, pra não atrapalhar toques. */
const SLOP = 8;
/** Janela de amostras usada pra medir a velocidade ao soltar. */
const VELOCITY_WINDOW_MS = 80;

/** Toques que começam aqui ficam com o comportamento nativo: campos de
 * texto, a alça de arrastar do setlist (dnd-kit) e qualquer coisa com
 * rolagem própria (ex: o editor de código). */
function keepsNativeTouch(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.matches('input, textarea, select, [contenteditable], .reorder-handle')) return true;
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** Substitui a rolagem nativa por toque da página por uma mais contida: o
 * arrasto move a página menos que o dedo e o embalo ao soltar é menor e
 * para mais rápido. A rolagem nativa do navegador não tem ajuste de
 * sensibilidade, por isso o gesto é refeito aqui. Mouse/roda não mudam. */
export function useDampedTouchScroll() {
  useEffect(() => {
    let tracking = false;
    let engaged = false;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let samples: { t: number; y: number }[] = [];
    let frame = 0;
    // Frações de pixel ainda não aplicadas — scrollBy com valores menores
    // que 1px pode ser ignorado (ex: Safari), então acumula até dar 1px.
    let pending = 0;

    function scrollPage(delta: number) {
      pending += delta;
      const whole = Math.trunc(pending);
      if (whole === 0) return;
      pending -= whole;
      window.scrollBy(0, whole);
    }

    function atEdge(direction: number): boolean {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return direction < 0 ? window.scrollY <= 0 : window.scrollY >= max - 1;
    }

    function stopMomentum() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function onTouchStart(e: TouchEvent) {
      stopMomentum();
      tracking = e.touches.length === 1 && !keepsNativeTouch(e.target);
      engaged = false;
      if (!tracking) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = lastY = t.clientY;
      samples = [{ t: e.timeStamp, y: t.clientY }];
      pending = 0;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      if (!engaged) {
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Puxar pra baixo no topo da página fica nativo, pra não perder o
        // "puxar pra atualizar"; gesto mais horizontal também.
        if (Math.abs(dx) > Math.abs(dy) || (dy > 0 && window.scrollY <= 0)) {
          tracking = false;
          return;
        }
        engaged = true;
        lastY = t.clientY;
      }
      if (!e.cancelable) return;
      e.preventDefault();
      scrollPage(-(t.clientY - lastY) * DRAG_FACTOR);
      lastY = t.clientY;
      samples.push({ t: e.timeStamp, y: t.clientY });
      while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();
    }

    function onTouchEnd() {
      if (!tracking || !engaged) {
        tracking = false;
        return;
      }
      tracking = false;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt <= 0) return;
      let velocity = (-(last.y - first.y) / dt) * DRAG_FACTOR * MOMENTUM_FACTOR;
      let prev = performance.now();
      function step(now: number) {
        const elapsed = now - prev;
        prev = now;
        scrollPage(velocity * elapsed);
        velocity *= Math.pow(FRICTION, elapsed / 16);
        // Para ao perder o embalo ou ao bater no topo/fim da página.
        if (Math.abs(velocity) < MIN_VELOCITY || atEdge(velocity)) {
          frame = 0;
          return;
        }
        frame = requestAnimationFrame(step);
      }
      frame = requestAnimationFrame(step);
    }

    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener('touchstart', onTouchStart, opts);
    document.addEventListener('touchmove', onTouchMove, opts);
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    return () => {
      stopMomentum();
      document.removeEventListener('touchstart', onTouchStart, opts);
      document.removeEventListener('touchmove', onTouchMove, opts);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);
}
