// Hero story: a choreographed loop of how an Aegis Gate escrow settles.
(() => {
  const $ = (id) => document.getElementById(id);
  const fig = $("story");
  if (!fig) return;
  const coin = $("sg-coin"), shackle = $("sg-shackle"), halo = $("sg-halo"), shield = $("sg-shield");
  const dots = [...fig.querySelectorAll(".story-dots i")];
  const P = { buyer: [70, 92], vault: [240, 196], seller: [410, 92] };
  const ease = "cubic-bezier(.65,0,.35,1)";
  const springy = "cubic-bezier(.3,1.6,.5,1)";
  const tr = ([x, y]) => `translate(${x}px, ${y}px)`;

  function anim(el, frames, duration, delay = 0, easing = ease) {
    return el.animate(frames, { duration, delay, easing, fill: "forwards" });
  }
  function pulse(el) {
    anim(el, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], 600, 0, "ease-out");
  }

  const scenes = [
    { t: "The buyer pays into the vault, not to a stranger.", d: 2200, run() {
      anim(coin, [{ transform: tr(P.buyer), opacity: 1 }, { transform: tr(P.vault), opacity: 1 }], 1500, 350);
      pulse($("sg-buyer"));
    } },
    { t: "Locked and shielded. The chain sees no amount, no names.", d: 2400, run() {
      anim(coin, [{ opacity: 1, transform: tr(P.vault) + " scale(1)" }, { opacity: 0, transform: tr(P.vault) + " scale(.4)" }], 450);
      anim(shackle, [{ transform: "translateY(-12px)" }, { transform: "translateY(0)" }], 420, 250, springy);
      anim(halo, [{ opacity: 0 }, { opacity: 1 }], 600, 300);
      anim(shield, [{ opacity: 0.9, transform: "scale(.85)" }, { opacity: 0, transform: "scale(2.1)" }], 1200, 450, "ease-out");
      anim($("sg-chain"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], 500, 900);
    } },
    { t: "The buyer confirms delivery. That's one key.", d: 2000, run() {
      anim($("sg-beam-buyer"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 700, 150);
      anim($("sg-ok-buyer"), [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], 380, 700, springy);
    } },
    { t: "The seller approves. Two of three keys make one signature.", d: 2400, run() {
      anim($("sg-beam-seller"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 700, 150);
      anim($("sg-ok-seller"), [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], 380, 700, springy);
      anim($("sg-sig"), [{ opacity: 0 }, { opacity: 1 }], 400, 1100);
    } },
    { t: "The vault opens and the seller is paid. The arbiter never woke up.", d: 2800, run() {
      anim(shackle, [{ transform: "translateY(0)" }, { transform: "translateY(-12px)" }], 400, 0, springy);
      anim(coin, [
        { opacity: 0, transform: tr(P.vault) + " scale(.4)" },
        { opacity: 1, transform: tr(P.vault) + " scale(1)", offset: 0.25 },
        { opacity: 1, transform: tr(P.seller) + " scale(1)" },
      ], 1500, 300);
      setTimeout(() => pulse($("sg-seller")), 1700);
    } },
  ];

  // Shield ring scales around its own centre.
  shield.style.transformBox = "fill-box";
  shield.style.transformOrigin = "center";
  ["sg-ok-buyer", "sg-ok-seller"].forEach((id) => { $(id).style.transformBox = "fill-box"; $(id).style.transformOrigin = "center"; });

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    coin.style.transform = tr(P.seller);
    ["sg-ok-buyer", "sg-ok-seller", "sg-sig", "sg-chain"].forEach((id) => ($(id).style.opacity = 1));
    ["sg-beam-buyer", "sg-beam-seller"].forEach((id) => ($(id).style.strokeDashoffset = 0));
    $("sgText").textContent = "The buyer pays into the vault, buyer and seller sign, and the seller is paid.";
    dots.forEach((d) => (d.dataset.state = "done"));
    $("sgToggle").hidden = true;
    return;
  }

  let i = 0, timer = null, paused = false, visible = true;
  const all = () => fig.getAnimations({ subtree: true });

  function show(n) {
    const sc = scenes[n];
    $("sgStep").textContent = String(n + 1).padStart(2, "0");
    $("sgText").textContent = sc.t;
    dots.forEach((d, k) => {
      d.dataset.state = k < n ? "done" : k === n ? "now" : "";
      d.style.setProperty("--dur", sc.d + "ms");
    });
    if (n === 0) all().forEach((a) => { if (!a.animationName) a.cancel(); });
    sc.run();
  }
  function tick() {
    if (paused || !visible) return;
    show(i);
    timer = setTimeout(() => { i = (i + 1) % scenes.length; timer = null; tick(); }, scenes[i].d);
  }
  function stop() { clearTimeout(timer); timer = null; all().forEach((a) => a.pause()); }
  function resume() { if (timer) return; all().forEach((a) => a.play()); tick(); }

  $("sgToggle").addEventListener("click", (e) => {
    paused = !paused;
    e.currentTarget.textContent = paused ? "Play" : "Pause";
    e.currentTarget.setAttribute("aria-label", paused ? "Play animation" : "Pause animation");
    paused ? stop() : resume();
  });
  new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (!visible) stop(); else if (!paused) resume();
  }, { threshold: 0.2 }).observe(fig);
})();
