// FastBite v3: สั่งอาหารผ่านห้องแชท (หน้าตาแบบแอปแชท) + หน้าสั่งอาหารแบบ LIFF
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString("th-TH");
const now = () => Date.now();
const hhmm = (ts) => new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
const dayKey = (ts) => new Date(ts).toDateString();

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: ใช้ต่อได้แค่ไม่จำ */ }
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : Array.isArray(d) ? "กรอกข้อมูลไม่ครบหรือไม่ถูกต้อง" : `เกิดข้อผิดพลาด (${res.status})`);
  }
  return data;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), 1800);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  shop: null,
  menu: [],
  byId: {},
  cart: load("fb3_cart", {}),          // { menuId: qty }
  msgs: load("fb3_chat", []),          // ประวัติแชท (เก็บในเครื่องผู้ใช้)
  orders: load("fb3_orders", []),      // [{ id, step, phone4 }] ออเดอร์ที่สั่งจากแชทนี้
  profile: load("fb3_profile", {}),    // ชื่อ/เบอร์/ที่อยู่ล่าสุด (เหมือนดึงจากโปรไฟล์)
  busy: false,
  attach: null,                        // { dataUrl, thumb } รูปที่รอส่ง
};
const imageCache = new Map();          // msgId -> dataUrl เต็ม (ไว้ส่งใหม่ถ้าส่งไม่สำเร็จ ไม่เก็บลงเครื่อง)

const STATUS_TEXT = [
  "ได้รับออเดอร์แล้วครับ",
  "ร้านกำลังเตรียมอาหารของคุณครับ 🍳",
  "ไรเดอร์รับอาหารแล้ว กำลังไปส่งครับ 🛵",
  "จัดส่งสำเร็จแล้วครับ ขอให้อร่อยนะครับ 😋",
];

const QUICK_DEFAULT = [
  { label: "ดูเมนูแนะนำ", action: "recommend" },
  { label: "ค่าส่งเท่าไหร่" },
  { label: "มีโปรอะไรบ้าง" },
  { label: "เมนูไหนเผ็ดบ้าง" },
  { label: "มาสองคน งบ 300 สั่งอะไรดี" },
  { label: "📷 ส่งรูป/สลิป", action: "photo" },
];

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
const log = $("#log");
let msgSeq = 0;

function persistMsgs() {
  S.msgs = S.msgs.slice(-80);
  save("fb3_chat", S.msgs);
}

function push(msg) {
  const m = { id: `${now()}-${msgSeq++}`, ts: now(), ...msg };
  S.msgs.push(m);
  persistMsgs();
  renderAppend(m);
  return m;
}

function updateMsg(m, patch) {
  Object.assign(m, patch);
  persistMsgs();
  const old = log.querySelector(`[data-mid="${m.id}"]`);
  if (old) old.replaceWith(renderMsg(m, prevOf(m)));
}

function prevOf(m) {
  const i = S.msgs.indexOf(m);
  return i > 0 ? S.msgs[i - 1] : null;
}

function renderAll() {
  log.replaceChildren();
  S.msgs.forEach((m, i) => {
    const prev = S.msgs[i - 1];
    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) log.append(dayChip(m.ts));
    log.append(renderMsg(m, prev));
  });
  scrollDown();
}

function renderAppend(m) {
  const prev = prevOf(m);
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) log.append(dayChip(m.ts));
  log.append(renderMsg(m, prev));
  scrollDown();
}

function dayChip(ts) {
  const d = new Date(ts);
  const label = dayKey(ts) === new Date().toDateString()
    ? "วันนี้"
    : d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });
  return el("div", { class: "day" }, label);
}

function scrollDown() {
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function renderMsg(m, prev) {
  if (m.kind === "sys") return el("div", { class: `sys${m.error ? " err" : ""}`, "data-mid": m.id }, m.text);

  if (m.from === "me") {
    const meta = el("div", { class: "meta" },
      m.status === "read" ? el("span", {}, "อ่านแล้ว") : null,
      m.status === "failed" ? null : el("span", {}, hhmm(m.ts))
    );
    const resend = m.status === "failed"
      ? el("button", { class: "resend", type: "button", title: "ส่งใหม่", "aria-label": "ส่งข้อความนี้ใหม่", onclick: () => resendMsg(m) }, "!")
      : null;
    const bubble = m.thumb
      ? el("div", { class: "bubble me has-img" }, el("img", { class: "msg-img", src: m.thumb, alt: "รูปที่ส่ง" }), m.text ? el("span", {}, m.text) : null)
      : el("div", { class: "bubble me" }, m.text);
    return el("div", { class: "row me", "data-mid": m.id },
      el("div", { class: "stack" },
        el("div", { class: "line" }, bubble, resend || meta)
      )
    );
  }

  // bot: แสดงรูป+ชื่อเฉพาะข้อความแรกของกลุ่ม เหมือนแอปแชททั่วไป
  const firstOfGroup = !prev || prev.from !== "bot" || prev.kind === "sys" || m.ts - prev.ts > 60_000;
  let body;
  if (m.kind === "flex") body = renderFlex(m.flex);
  else body = botBubble(m);

  return el("div", { class: "row bot", "data-mid": m.id },
    firstOfGroup ? el("span", { class: "avatar", "aria-hidden": "true" }, "FB") : el("span", { class: "avatar", style: "visibility:hidden", "aria-hidden": "true" }),
    el("div", { class: "stack" },
      firstOfGroup ? el("span", { class: "name" }, S.shop?.name || "FastBite") : null,
      el("div", { class: "line" }, body, el("div", { class: "meta" },
        m.elapsed_ms != null ? el("span", { class: "elapsed", title: "เวลาที่ใช้ตอบ" }, `${(m.elapsed_ms / 1000).toFixed(1)} วิ`) : null,
        el("span", {}, hhmm(m.ts))))
    )
  );
}

function botBubble(m) {
  const b = el("div", { class: "bubble bot" });
  if (window.marked && window.DOMPurify) b.innerHTML = DOMPurify.sanitize(marked.parse(m.text || "", { breaks: true }));
  else { b.style.whiteSpace = "pre-wrap"; b.textContent = m.text; }
  if (m.sources?.length) b.append(el("div", { class: "sources" }, "อ้างอิง: " + m.sources.map((s) => s.ref).join(", ")));
  return b;
}

// ---------------------------------------------------------------------------
// Flex cards (ร้านออกแบบเอง)
// ---------------------------------------------------------------------------
function renderFlex(f) {
  if (f.type === "welcome") return flexWelcome();
  if (f.type === "carousel") return flexCarousel(f.ids, f.more);
  if (f.type === "receipt") return flexReceipt(f.order);
  if (f.type === "status") return flexStatus(f.order);
  if (f.type === "payqr") return flexPayQr(f.pay);
  return el("div", { class: "bubble bot" }, "(ข้อความไม่รองรับ)");
}

function flexWelcome() {
  const s = S.shop || {};
  return el("div", { class: "flex" },
    el("div", { class: "flex-hero" }, "หิวตอนไหน", el("br"), "สั่งได้ตอนนั้น"),
    el("div", { class: "flex-body" },
      el("div", { class: "fact" }, el("span", {}, "ส่งถึงใน"), el("span", {}, `${s.eta_minutes || "30-45"} นาที`)),
      el("div", { class: "fact" }, el("span", {}, "ค่าส่ง"), el("span", {}, `${fmt(s.delivery_fee ?? 30)} บาท`)),
      el("div", { class: "fact" }, el("span", {}, "ส่งฟรีเมื่อสั่งครบ"), el("span", {}, `${fmt(s.free_delivery_min ?? 300)} บาท`))
    ),
    el("div", { class: "flex-foot" },
      el("button", { class: "fbtn", type: "button", onclick: () => openLiff("menu") }, "สั่งอาหาร"),
      el("button", { class: "fbtn ghost", type: "button", onclick: () => doAction("recommend") }, "ดูเมนูแนะนำ")
    )
  );
}

function flexCarousel(ids, more) {
  const cards = ids.map((id) => S.byId[id]).filter(Boolean).map(dishCard);
  if (more) cards.push(el("div", { class: "flex more" }, el("button", { type: "button", onclick: () => openLiff("menu") }, "ดูเมนูทั้งหมด")));
  return el("div", { class: "carousel", role: "group", "aria-label": "การ์ดเมนู" }, cards);
}

function dishCard(m) {
  return el("article", { class: `flex${m.available ? "" : " out"}` },
    el("div", { class: "dish-pic", "aria-hidden": "true" }, m.emoji || "🍽️"),
    el("div", { class: "flex-body" },
      el("span", { class: "dish-name" }, m.name),
      el("span", { class: "dish-desc" }, m.description),
      el("span", { class: "dish-price" }, `${fmt(m.price)} บาท`)
    ),
    el("div", { class: "flex-foot" },
      el("button", {
        class: "fbtn", type: "button", "data-dish": m.id, disabled: !m.available,
        onclick: () => { setQty(m.id, (S.cart[m.id] || 0) + 1); toast(`เพิ่ม ${m.name} แล้ว`); },
      }, dishBtnLabel(m))
    )
  );
}

function dishBtnLabel(m) {
  if (!m.available) return "หมดชั่วคราว";
  const q = S.cart[m.id] || 0;
  return q ? `เพิ่มอีก (มี ${q})` : "ใส่ตะกร้า";
}

function refreshDishButtons() {
  log.querySelectorAll("[data-dish]").forEach((b) => { b.textContent = dishBtnLabel(S.byId[b.dataset.dish]); });
}

function flexReceipt(o) {
  return el("div", { class: "flex receipt" },
    el("div", { class: "flex-body" },
      el("span", { class: "small" }, "เลขออเดอร์"),
      el("span", { class: "receipt-no" }, o.id),
      el("ul", { class: "receipt-lines" },
        o.items.map((it) => el("li", {}, el("span", {}, `${it.name} ×${it.qty}`), el("span", {}, fmt(it.line_total))))
      ),
      el("div", { class: "fact" }, el("span", {}, "ค่าจัดส่ง"), el("span", {}, o.delivery_fee ? fmt(o.delivery_fee) : "ฟรี")),
      el("div", { class: "receipt-total" }, el("span", {}, "รวม"), el("span", {}, `${fmt(o.total)} บาท`)),
      el("span", { class: "small" }, `ส่งถึง ${o.customer.name}, ${o.customer.address}`),
      el("span", { class: "small" }, `ชำระเงิน: ${o.payment}`)
    ),
    el("div", { class: "flex-foot" },
      el("button", { class: "fbtn ghost", type: "button", onclick: () => showStatus(o.id) }, "ดูสถานะ")
    )
  );
}

// QR ชำระเงิน (จำลอง): เข้ารหัสข้อความทดสอบ ไม่ใช่ข้อมูลพร้อมเพย์จริง สแกนจ่ายจริงไม่ได้
function flexPayQr(p) {
  const amount = Number(p.amount).toFixed(2);
  const box = el("div", { class: "qr-box", role: "img", "aria-label": `QR ชำระเงิน ${amount} บาท` });
  try {
    const qr = qrcode(0, "M");
    qr.addData(`FASTBITE-TEST|${p.id}|${amount}`);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch {
    box.textContent = "แสดง QR ไม่ได้";
  }
  return el("div", { class: "flex payqr" },
    el("div", { class: "payqr-head" }, p.remaining ? "สแกนจ่ายส่วนที่ค้าง" : "สแกนเพื่อชำระเงิน"),
    el("div", { class: "flex-body" },
      box,
      el("span", { class: "payqr-amount" }, `${fmt(amount)} บาท`),
      el("span", { class: "small" }, `บัญชี ${S.shop?.promptpay_name || S.shop?.name || "FastBite"} · ออเดอร์ ${p.id}`),
      el("span", { class: "payqr-note" }, "QR ทดสอบ สแกนจ่ายจริงไม่ได้")
    ),
    el("div", { class: "flex-foot" },
      el("button", { class: "fbtn", type: "button", onclick: () => doAction("slip") }, "📷 ส่งสลิป")
    )
  );
}

function flexStatus(o) {
  const finished = o.status === "delivered";
  const cls = (i) => (finished || i < o.step_index ? "done" : i === o.step_index ? "now" : "");
  return el("div", { class: "flex" },
    el("div", { class: "flex-body" },
      el("span", { class: "small" }, `ออเดอร์ ${o.id}`),
      el("strong", {}, o.status_label),
      el("ol", { class: "steps" },
        o.steps.map((s, i) => el("li", { class: cls(i) }, s))
      ),
      o.payment_status
        ? el("span", { class: `pay-line pay-${o.payment_status.state}` }, `💳 ${o.payment_status.label}`)
        : null
    )
  );
}

// ---------------------------------------------------------------------------
// quick replies
// ---------------------------------------------------------------------------
function setQuick(items) {
  $("#quick").replaceChildren(
    ...items.map((q) => el("button", {
      type: "button",
      onclick: () => (q.action ? doAction(q.action) : sendChat(q.text || q.label)),
    }, q.label))
  );
  $("#quick").scrollLeft = 0;
}

// ---------------------------------------------------------------------------
// chat with AI (RAG ทำที่ backend)
// ---------------------------------------------------------------------------
function chatHistory(exclude) {
  return S.msgs
    .filter((m) => m !== exclude && m.kind === "text" && !m.offline && m.status !== "failed" && !m.local)
    .slice(-10)
    .map((m) => ({ role: m.from === "me" ? "user" : "assistant", content: m.thumb ? `[แนบรูปภาพ] ${m.text}` : m.text }));
}

function lastOrder() {
  return S.orders[S.orders.length - 1] || null;
}

async function sendChat(text, existing, image) {
  text = text.trim();
  if (image && !text) text = "ส่งรูปภาพ";
  if (!text || S.busy) return;
  const dataUrl = image?.dataUrl || (existing && imageCache.get(existing.id)) || null;
  if (existing?.thumb && !dataUrl) {
    // รีเฟรชหน้าแล้วรูปเต็มหายไป ส่งซ้ำไม่ได้
    push({ kind: "sys", text: "รูปนี้ส่งใหม่ไม่ได้แล้ว กรุณาแนบรูปอีกครั้ง", error: true });
    return;
  }
  S.busy = true;
  setQuick([]);
  const me = existing || push({ kind: "text", from: "me", text, status: "sent", thumb: image?.thumb });
  if (existing) updateMsg(me, { status: "sent" });
  if (dataUrl) imageCache.set(me.id, dataUrl);

  const typing = el("div", { class: "row bot" },
    el("span", { class: "avatar", "aria-hidden": "true" }, "FB"),
    el("div", { class: "bubble bot typing", "aria-label": "กำลังพิมพ์" }, el("span"), el("span"), el("span"))
  );
  setTimeout(() => { if (me.status === "sent") updateMsg(me, { status: "read" }); }, 350);
  log.append(typing);
  scrollDown();

  try {
    const payload = {
      message: text,
      history: chatHistory(me),
      cart: Object.entries(S.cart).map(([id, qty]) => ({ id, qty })),
      order_id: lastOrder()?.id || null,
    };
    if (dataUrl) payload.image = dataUrl;
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify(payload) });
    typing.remove();
    imageCache.delete(me.id);
    push({ kind: "text", from: "bot", text: data.reply || "(ไม่มีคำตอบ)", sources: data.sources || [], offline: !!data.offline, elapsed_ms: data.elapsed_ms });
    const verdict = data.image?.verdict;
    if (verdict === "paid" || verdict === "overpaid") setTimeout(pollOrders, 800); // จ่ายครบ → ร้านเริ่มทำ แจ้งสถานะทันที
    if (verdict === "partial" || (verdict === "duplicate" && data.image?.remaining > 0)) {
      if (data.image.order_id) push({ kind: "flex", from: "bot", flex: { type: "payqr", pay: { id: data.image.order_id, amount: data.image.remaining, remaining: true } } });
      setQuick([{ label: "📷 ส่งสลิปเพิ่ม", action: "slip" }, { label: "ติดตามออเดอร์", action: "track" }]);
    } else if (data.menu_ids?.length) {
      push({ kind: "flex", from: "bot", flex: { type: "carousel", ids: data.menu_ids, more: true } });
      setQuick([{ label: "ดูตะกร้า", action: "cart" }, { label: "สั่งอาหาร", action: "order" }, ...QUICK_DEFAULT.slice(1, 3)]);
    } else {
      setQuick(QUICK_DEFAULT);
    }
  } catch (err) {
    typing.remove();
    updateMsg(me, { status: "failed" });
    push({ kind: "sys", text: `ส่งไม่สำเร็จ: ${err.message}`, error: true });
    setQuick(QUICK_DEFAULT);
  } finally {
    S.busy = false;
  }
}

function resendMsg(m) {
  if (S.busy) return;
  sendChat(m.text, m);
}

// ---------------------------------------------------------------------------
// rich menu actions
// ---------------------------------------------------------------------------
function botSay(text, extra = {}) {
  return push({ kind: "text", from: "bot", text, local: true, ...extra });
}

async function doAction(action) {
  switch (action) {
    case "order": return openLiff("menu");
    case "cart": return openLiff("cart");
    case "promo": return sendChat("มีโปรอะไรบ้าง");
    case "contact": return sendChat("ติดต่อร้านยังไง");
    case "photo": return pickImage("");
    case "slip": {
      const o = lastOrder();
      return pickImage(o ? `ส่งสลิปโอนเงิน ออเดอร์ ${o.id}` : "ส่งสลิปโอนเงิน");
    }
    case "food-issue": {
      const o = lastOrder();
      return pickImage(o ? `ได้อาหารไม่ครบ ออเดอร์ ${o.id}` : "ได้อาหารไม่ครบ");
    }
    case "recommend": {
      push({ kind: "text", from: "me", text: "ขอดูเมนูแนะนำ", status: "read", local: true });
      const picks = S.menu.filter((m) => m.available && m.tags.some((t) => ["ขายดี", "คุ้ม", "ใหม่"].includes(t))).slice(0, 6);
      botSay("เมนูแนะนำของร้านครับ กดใส่ตะกร้าได้เลย 👇");
      push({ kind: "flex", from: "bot", flex: { type: "carousel", ids: picks.map((m) => m.id), more: true } });
      return setQuick([{ label: "ดูตะกร้า", action: "cart" }, ...QUICK_DEFAULT.slice(1)]);
    }
    case "track": {
      push({ kind: "text", from: "me", text: "ติดตามออเดอร์", status: "read", local: true });
      const last = S.orders[S.orders.length - 1];
      if (!last) {
        botSay("ยังไม่มีออเดอร์จากแชทนี้ครับ ถ้าสั่งไว้แล้ว พิมพ์เลขออเดอร์ที่ขึ้นต้นด้วย FB มาได้เลย");
        return setQuick([{ label: "สั่งอาหาร", action: "order" }]);
      }
      return showStatus(last.id);
    }
  }
}

async function showStatus(id) {
  // ดูสถานะต้องใช้เบอร์ 4 ตัวท้ายคู่กับเลขออเดอร์ (เก็บไว้ตอนสั่งจากแชทนี้)
  const rec = S.orders.find((o) => o.id === id);
  if (!rec?.phone4) {
    push({ kind: "sys", text: "ไม่พบข้อมูลออเดอร์นี้ในเครื่อง พิมพ์เลขออเดอร์มาถามในแชทได้ครับ", error: true });
    return;
  }
  try {
    const o = await api(`/api/orders/${encodeURIComponent(id)}?phone4=${rec.phone4}`);
    push({ kind: "flex", from: "bot", flex: { type: "status", order: o } });
  } catch (err) {
    push({ kind: "sys", text: err.message, error: true });
  }
}

document.querySelectorAll(".rm-tile").forEach((b) => b.addEventListener("click", () => doAction(b.dataset.action)));

// ---------------------------------------------------------------------------
// bottom bar: สลับ ช่องพิมพ์ <-> ริชเมนู
// ---------------------------------------------------------------------------
const composer = $("#composer");
const input = $("#input");

function showKeyboard() {
  composer.classList.remove("hidden");
  $("#menubar").classList.add("hidden");
  $("#richmenu").classList.add("hidden");
  input.focus();
}
function showRichMenu() {
  composer.classList.add("hidden");
  $("#menubar").classList.remove("hidden");
  $("#richmenu").classList.remove("hidden");
  $("#menu-toggle").setAttribute("aria-expanded", "true");
  scrollDown();
}
$("#to-keyboard").addEventListener("click", showKeyboard);
$("#to-menu").addEventListener("click", showRichMenu);
$("#menu-toggle").addEventListener("click", (e) => {
  const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
  e.currentTarget.setAttribute("aria-expanded", String(open));
  $("#richmenu").classList.toggle("hidden", !open);
  scrollDown();
});

const refreshSend = () => { $("#send").disabled = !input.value.trim() && !S.attach; };
input.addEventListener("input", refreshSend);
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !S.attach) return;
  if (S.busy) return;
  const image = S.attach;
  input.value = "";
  clearAttach();
  sendChat(text, null, image);
});

// ---------------------------------------------------------------------------
// แนบรูป: ย่อรูปในเครื่องก่อนส่ง (ด้านยาวสุด 1280px, JPEG) ประหยัดเน็ตและค่าโมเดล
// ---------------------------------------------------------------------------
const fileInput = $("#file");

function pickImage(presetText) {
  showKeyboard();
  if (presetText && !input.value.trim()) input.value = presetText;
  refreshSend();
  fileInput.click();
}

$("#attach-btn").addEventListener("click", () => fileInput.click());
$("#attach-remove").addEventListener("click", () => { clearAttach(); input.focus(); });

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("ส่งได้เฉพาะไฟล์รูปภาพ");
  if (file.size > 15 * 1024 * 1024) return toast("รูปใหญ่เกิน 15 MB");
  try {
    const img = await loadImage(file);
    S.attach = { dataUrl: resizeImage(img, 1280, 0.85), thumb: resizeImage(img, 320, 0.7) };
    $("#attach-thumb").src = S.attach.thumb;
    $("#attach-preview").classList.remove("hidden");
    refreshSend();
    input.focus();
  } catch {
    toast("เปิดรูปนี้ไม่ได้ ลองใช้ไฟล์ JPG หรือ PNG");
  }
});

function clearAttach() {
  S.attach = null;
  $("#attach-preview").classList.add("hidden");
  $("#attach-thumb").removeAttribute("src");
  refreshSend();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

function resizeImage(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; // PNG โปร่งใส → พื้นขาว
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

// เมนู ⋮
$("#more-btn").addEventListener("click", (e) => {
  const menu = $("#more-menu");
  const open = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".top-actions")) { $("#more-menu").classList.add("hidden"); $("#more-btn").setAttribute("aria-expanded", "false"); }
});
$("#clear-chat").addEventListener("click", () => {
  S.msgs = [];
  persistMsgs();
  $("#more-menu").classList.add("hidden");
  welcome();
});

// ---------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------
function setQty(id, qty) {
  qty = Math.max(0, Math.min(20, qty));
  if (qty === 0) delete S.cart[id];
  else S.cart[id] = qty;
  save("fb3_cart", S.cart);
  refreshDishButtons();
  renderBadge();
  if (!$("#liff").classList.contains("hidden")) renderLiff();
}

function totals() {
  const lines = Object.entries(S.cart)
    .map(([id, qty]) => ({ item: S.byId[id], qty }))
    .filter((l) => l.item && l.item.available);
  const subtotal = lines.reduce((s, l) => s + l.item.price * l.qty, 0);
  const { delivery_fee, free_delivery_min, min_order } = S.shop;
  const fee = subtotal === 0 || subtotal >= free_delivery_min ? 0 : delivery_fee;
  return { lines, subtotal, fee, total: subtotal + fee, count: lines.reduce((s, l) => s + l.qty, 0), min_order, free_delivery_min };
}

function renderBadge() {
  const c = totals().count;
  const b = $("#rm-cart-badge");
  b.textContent = c;
  b.classList.toggle("hidden", c === 0);
}

function stepper(id, qty, name) {
  return el("div", { class: "stepper" },
    el("button", { type: "button", "aria-label": `ลด ${name}`, onclick: () => setQty(id, qty - 1) }, "−"),
    el("span", {}, String(qty)),
    el("button", { type: "button", "aria-label": `เพิ่ม ${name}`, onclick: () => setQty(id, qty + 1) }, "+")
  );
}

// ---------------------------------------------------------------------------
// LIFF sheet: เมนู -> ตะกร้า/ที่อยู่ -> ยืนยัน
// ---------------------------------------------------------------------------
const liff = $("#liff");
let liffStep = "menu";
let liffOpener = null;

function openLiff(step) {
  liffOpener = document.activeElement;
  liffStep = step;
  liff.classList.remove("hidden");
  renderMenuList();
  fillProfile();
  renderLiff();
  $("#liff-close").focus();
}
function closeLiff() {
  liff.classList.add("hidden");
  $("#checkout-error").classList.add("hidden");
  liffOpener?.focus?.();
}
$("#liff-close").addEventListener("click", closeLiff);
$("#liff-back").addEventListener("click", () => { liffStep = "menu"; renderLiff(); });
liff.addEventListener("click", (e) => { if (e.target === liff) closeLiff(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !liff.classList.contains("hidden")) closeLiff(); });

function renderLiff() {
  const t = totals();
  const onMenu = liffStep === "menu";
  $("#liff-title").textContent = onMenu ? "สั่งอาหาร" : "ตะกร้าและที่อยู่";
  $("#liff-back").classList.toggle("hidden", onMenu);
  $("#step-menu").classList.toggle("hidden", !onMenu);
  $("#step-cart").classList.toggle("hidden", onMenu);

  if (onMenu) {
    // วาดเฉพาะแถวเมนูใหม่ เก็บตำแหน่ง scroll ไว้
    document.querySelectorAll("#menu-list .item").forEach((row) => row.replaceWith(menuRow(S.byId[row.dataset.id])));
  } else {
    renderCartLines(t);
  }

  const btn = $("#foot-btn");
  $("#foot-total").textContent = `${fmt(onMenu ? t.subtotal : t.total)} บาท`;
  const below = t.subtotal < t.min_order;
  $("#min-hint").classList.toggle("hidden", onMenu || t.count === 0 || !below);
  $("#min-hint").textContent = `ยอดขั้นต่ำ ${fmt(t.min_order)} บาท ขาดอีก ${fmt(t.min_order - t.subtotal)} บาท`;
  if (onMenu) {
    $("#foot-label").textContent = t.count ? `ดูตะกร้า (${t.count})` : "ยังไม่ได้เลือกเมนู";
    btn.disabled = t.count === 0;
  } else {
    $("#foot-label").textContent = "ยืนยันสั่ง";
    btn.disabled = t.count === 0 || below;
  }
}

function renderMenuList() {
  const groups = new Map();
  for (const m of S.menu) {
    if (!groups.has(m.category)) groups.set(m.category, []);
    groups.get(m.category).push(m);
  }
  const chips = $("#chips");
  chips.replaceChildren(...[...groups.keys()].map((cat, i) =>
    el("button", {
      class: "chip", type: "button", role: "tab", "aria-selected": i === 0 ? "true" : "false",
      onclick: (e) => {
        chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-selected", "false"));
        e.currentTarget.setAttribute("aria-selected", "true");
        document.getElementById(`g-${i}`).scrollIntoView({ behavior: "smooth", block: "start" });
      },
    }, cat)
  ));
  $("#menu-list").replaceChildren(...[...groups.entries()].map(([cat, items], i) =>
    el("section", { class: "group", id: `g-${i}` }, el("h3", {}, cat), el("ul", { class: "items" }, items.map(menuRow)))
  ));
}

function menuRow(m) {
  const qty = S.cart[m.id] || 0;
  const tags = [];
  if (m.spicy) tags.push(el("span", { class: "tag hot" }, "เผ็ด" + "🌶".repeat(m.spicy)));
  for (const t of m.tags) if (t !== "เผ็ด") tags.push(el("span", { class: "tag" }, t));
  let control;
  if (!m.available) control = el("span", { class: "sold" }, "หมดชั่วคราว");
  else if (!qty) control = el("button", { class: "add", type: "button", "aria-label": `เพิ่ม ${m.name}`, onclick: () => setQty(m.id, 1) }, "+");
  else control = stepper(m.id, qty, m.name);

  return el("li", { class: `item${m.available ? "" : " out"}`, "data-id": m.id },
    el("div", { class: "item-pic", "aria-hidden": "true" }, m.emoji || "🍽️"),
    el("div", {},
      el("p", { class: "item-name" }, m.name),
      el("p", { class: "item-desc" }, m.description),
      tags.length ? el("div", { class: "item-tags" }, tags) : null
    ),
    el("div", { class: "item-side" }, el("span", { class: "price" }, `${fmt(m.price)} ฿`), control)
  );
}

function renderCartLines(t) {
  $("#cart-empty").classList.toggle("hidden", t.count > 0);
  $("#cart-lines").replaceChildren(...t.lines.map(({ item, qty }) =>
    el("li", {}, el("span", {}, item.name), el("span", {}, fmt(item.price * qty)), stepper(item.id, qty, item.name))
  ));
  $("#sum-sub").textContent = fmt(t.subtotal);
  $("#sum-fee").textContent = t.fee === 0 ? "ฟรี" : fmt(t.fee);
  $("#sum-total").textContent = `${fmt(t.total)} บาท`;
  const left = t.free_delivery_min - t.subtotal;
  $("#free-fill").style.width = `${Math.min(100, (t.subtotal / t.free_delivery_min) * 100)}%`;
  const hint = $("#free-hint");
  hint.classList.toggle("done", left <= 0);
  hint.textContent = left > 0 ? `อีก ${fmt(left)} บาท ส่งฟรี` : "ได้ส่งฟรีแล้ว";
}

function fillProfile() {
  const f = $("#step-cart");
  for (const k of ["name", "phone", "address"]) if (!f.elements[k].value && S.profile[k]) f.elements[k].value = S.profile[k];
}

$("#foot-btn").addEventListener("click", () => {
  if (liffStep === "menu") { liffStep = "cart"; renderLiff(); $("#step-cart").scrollTop = 0; return; }
  placeOrder();
});
$("#step-cart").addEventListener("submit", (e) => { e.preventDefault(); placeOrder(); });

async function placeOrder() {
  const form = $("#step-cart");
  const err = $("#checkout-error");
  err.classList.add("hidden");
  if (!form.checkValidity()) {
    err.textContent = "กรอกชื่อ เบอร์โทร และที่อยู่ให้ครบก่อนสั่ง";
    err.classList.remove("hidden");
    form.reportValidity();
    return;
  }
  const fd = new FormData(form);
  const customer = { name: fd.get("name").trim(), phone: fd.get("phone").trim(), address: fd.get("address").trim() };
  const body = {
    items: totals().lines.map((l) => ({ id: l.item.id, qty: l.qty })),
    customer,
    payment: fd.get("payment"),
    note: (fd.get("note") || "").trim(),
  };

  const btn = $("#foot-btn");
  btn.disabled = true;
  try {
    const o = await api("/api/orders", { method: "POST", body: JSON.stringify(body) });
    S.profile = customer; save("fb3_profile", customer);
    S.cart = {}; save("fb3_cart", S.cart);
    S.orders.push({ id: o.id, step: o.step_index, phone4: o.customer.phone.slice(-4) }); save("fb3_orders", S.orders);
    form.elements.note.value = "";
    closeLiff();
    renderBadge();
    refreshDishButtons();

    // หน้าสั่งอาหารส่งข้อความเข้าแชทแทนลูกค้า แล้วร้านตอบใบเสร็จกลับมา
    push({ kind: "text", from: "me", text: `ยืนยันสั่งอาหาร\nเลขออเดอร์ ${o.id}`, status: "read", local: true });
    botSay(o.step_index < 0
      ? "บันทึกออเดอร์แล้วครับ 🙏 ร้านจะเริ่มเตรียมอาหารเมื่อได้รับสลิปครบยอด"
      : `${STATUS_TEXT[0]} 🙏 จะแจ้งความคืบหน้าในแชทนี้นะครับ`);
    push({ kind: "flex", from: "bot", flex: { type: "receipt", order: o } });
    if (o.payment === "QR PromptPay") {
      botSay(`สแกน QR ด้านล่างเพื่อชำระ **${fmt(o.total)} บาท** แล้วส่งรูปสลิปในแชทนี้ได้เลยครับ 📷`);
      push({ kind: "flex", from: "bot", flex: { type: "payqr", pay: { id: o.id, amount: o.total } } });
      setQuick([{ label: "📷 ส่งสลิปโอนเงิน", action: "slip" }, { label: "ติดตามออเดอร์", action: "track" }, { label: "ยกเลิกออเดอร์ได้ไหม" }]);
    } else {
      setQuick([{ label: "ติดตามออเดอร์", action: "track" }, { label: "ยกเลิกออเดอร์ได้ไหม" }]);
    }
    startPolling();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
    renderLiff();
  }
}

// ---------------------------------------------------------------------------
// แจ้งสถานะอัตโนมัติ (จำลองการ push จากร้าน)
// ---------------------------------------------------------------------------
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOrders, 10_000);
}
async function pollOrders() {
  const pending = S.orders.filter((o) => o.step < 3);
  if (!pending.length) { clearInterval(pollTimer); pollTimer = null; return; }
  for (const rec of pending) {
    try {
      if (!rec.phone4) throw new Error("no phone4");
      const o = await api(`/api/orders/${rec.id}?phone4=${rec.phone4}`);
      if (o.step_index > rec.step) {
        rec.step = o.step_index;
        save("fb3_orders", S.orders);
        botSay(`ออเดอร์ ${o.id}: ${STATUS_TEXT[o.step_index]}`);
        push({ kind: "flex", from: "bot", flex: { type: "status", order: o } });
        if (o.step_index === 3) setQuick([{ label: "📷 แจ้งอาหารไม่ครบ", action: "food-issue" }, ...QUICK_DEFAULT.slice(0, 3)]);
      }
    } catch {
      rec.step = 3; // หาออเดอร์ไม่เจอแล้ว (เช่น ลบ orders.json) หยุดติดตาม
      save("fb3_orders", S.orders);
    }
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function welcome() {
  botSay(`สวัสดีครับ ขอบคุณที่เพิ่ม ${S.shop.name} เป็นเพื่อน 🍔\nกด "สั่งอาหาร" ที่เมนูด้านล่าง หรือพิมพ์ถามเรื่องเมนู ค่าส่ง โปรโมชั่นได้เลยครับ`);
  push({ kind: "flex", from: "bot", flex: { type: "welcome" } });
  renderAll();
  setQuick(QUICK_DEFAULT);
}

(async function init() {
  try {
    const [shop, menu] = await Promise.all([api("/api/shop"), api("/api/menu")]);
    S.shop = shop;
    S.menu = menu;
    S.byId = Object.fromEntries(menu.map((m) => [m.id, m]));
  } catch (err) {
    log.append(el("div", { class: "sys err" }, `โหลดข้อมูลร้านไม่สำเร็จ: ${err.message}`));
    return;
  }
  document.title = `${S.shop.name} แชทสั่งอาหาร`;
  $("#shop-name").textContent = S.shop.name;
  $("#pay-options").replaceChildren(...S.shop.payment_methods.map((p, i) =>
    el("label", {}, el("input", { type: "radio", name: "payment", value: p, checked: i === 0, required: true }), p)
  ));
  for (const id of Object.keys(S.cart)) if (!S.byId[id]) delete S.cart[id];
  renderBadge();

  if (!S.msgs.length) welcome();
  else { renderAll(); setQuick(QUICK_DEFAULT); }

  if (S.orders.some((o) => o.step < 3)) { startPolling(); pollOrders(); }
})();
