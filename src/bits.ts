// Vanilla ports of React Bits components (https://reactbits.dev, MIT + Commons Clause, David Haz).
// CountUp, ShinyText (CSS in index.html), and ClickSpark, reduced to the parts this app uses.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// CountUp: the displayed number chases its target on a spring, so live counters glide instead of flicker.
export function countUp(el: HTMLElement, { duration = 0.8, format = (v: number) => Math.round(v).toLocaleString("en-US") } = {}) {
  const stiffness = 100 / duration;
  const damping = 20 + 40 / duration;
  let value = 0, velocity = 0, target = 0, raf = 0, last = 0;
  el.textContent = format(0);

  const tick = (now: number) => {
    const dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    // Semi-implicit Euler, substepped: the spring is stiff relative to a 16 ms frame.
    for (let i = 0; i < 4; i++) {
      const h = dt / 4;
      velocity += (stiffness * (target - value) - damping * velocity) * h;
      value += velocity * h;
    }
    if (Math.abs(target - value) < 0.5 && Math.abs(velocity) < 0.5) {
      value = target;
      velocity = 0;
      raf = 0;
    } else {
      raf = requestAnimationFrame(tick);
    }
    el.textContent = format(value);
  };

  return {
    set(next: number, { instant = false } = {}) {
      target = next;
      if (instant || reduceMotion) {
        value = next;
        velocity = 0;
        el.textContent = format(next);
        return;
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
  };
}

// ClickSpark: short lines burst outward from a point and ease away.
export function clickSpark(canvas: HTMLCanvasElement, { color = "#ededed", count = 9, radius = 22, size = 9, duration = 420 } = {}) {
  const ctx = canvas.getContext("2d")!;
  const sparks: { x: number; y: number; angle: number; start: number; color: string }[] = [];
  let raf = 0;

  const fit = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  new ResizeObserver(fit).observe(canvas);
  fit();

  const draw = (now: number) => {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      const t = (now - s.start) / duration;
      if (t >= 1) {
        sparks.splice(i, 1);
        continue;
      }
      const eased = 1 - (1 - t) ** 3;
      const dist = eased * radius;
      const len = size * (1 - eased);
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 1 - t * 0.6;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x + dist * Math.cos(s.angle), s.y + dist * Math.sin(s.angle));
      ctx.lineTo(s.x + (dist + len) * Math.cos(s.angle), s.y + (dist + len) * Math.sin(s.angle));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    raf = sparks.length ? requestAnimationFrame(draw) : 0;
  };

  return (x: number, y: number, sparkColor = color) => {
    if (reduceMotion) return;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      sparks.push({ x, y, angle: (2 * Math.PI * i) / count, start, color: sparkColor });
    }
    if (!raf) raf = requestAnimationFrame(draw);
  };
}
