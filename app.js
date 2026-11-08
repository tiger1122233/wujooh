const { SUPABASE_URL, SUPABASE_KEY, BUCKET } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const app = document.getElementById("app");
const userBar = document.getElementById("userBar");

// تنسيقات إضافية بدون ما نعدّل style.css
const extraStyle = document.createElement("style");
extraStyle.textContent = `
  .avatar-circle { display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:#6c5ce7; color:#fff; font-weight:700; flex-shrink:0; }
  .avatar-img { border-radius:50%; object-fit:cover; flex-shrink:0; }
  .friend-row { display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid #e4e6ef; flex-wrap:wrap; }
  .friend-row .spacer { flex:1; }
  .link { cursor:pointer; color:#6c5ce7; }
  .profile-head { text-align:center; }
  .nav-on { font-weight:700; color:#6c5ce7; }
  .badge { display:none; background:#e17055; color:#fff; border-radius:10px; padding:0 6px; font-size:12px; line-height:18px; min-width:18px; text-align:center; }
  .unread { background:#f3f1ff; border-radius:8px; padding-inline:8px; }
  button:disabled { opacity:.6; cursor:default; }
`;
document.head.appendChild(extraStyle);

let CURRENT = null;
let view = "feed";
let profileId = null;
let badgeTimer = null;

const POST_COLS = "id, body, image_url, created_at, author_id, likes(user_id), comments(id, body, created_at, author_id)";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ago(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "الآن";
  if (s < 3600) return "منذ " + Math.floor(s / 60) + " دقيقة";
  if (s < 86400) return "منذ " + Math.floor(s / 3600) + " ساعة";
  return "منذ " + Math.floor(s / 86400) + " يوم";
}

/* ---------- Helpers ---------- */

function otherId(r, uid) {
  return r.requester_id === uid ? r.addressee_id : r.requester_id;
}

async function getRelations(uid) {
  const { data } = await sb.from("friendships")
    .select("requester_id, addressee_id, status")
    .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
  return data || [];
}

async function getNames(ids) {
  const names = {};
  if (!ids.length) return names;
  const { data } = await sb.from("profiles").select("id, name").in("id", ids);
  (data || []).forEach(p => { names[p.id] = p.name; });
  return names;
}

function avatarHTML(prof, size) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (prof.avatar_url) return `<img src="${esc(prof.avatar_url)}" alt="" class="avatar-img" style="${style}">`;
  const initials = esc((prof.name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join(""));
  return `<span class="avatar-circle" style="${style}">${initials}</span>`;
}

function relBtn(r, id, me) {
  if (!r) return `<button data-act="add" data-id="${id}">إضافة صديق</button>`;
  if (r.status === "accepted") return `<button class="ghost" data-act="remove" data-id="${id}">✓ أصدقاء</button>`;
  if (r.requester_id === me) return `<button class="ghost" data-act="remove" data-id="${id}">إلغاء الطلب</button>`;
  return `<button data-act="accept" data-id="${id}">قبول الطلب</button>`;
}

/* ---------- Auth ---------- */

async function renderAuth(mode = "login") {
  userBar.innerHTML = "";
  app.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <button id="tLogin" class="${mode === "login" ? "" : "ghost"}">دخول</button>
        <button id="tReg" class="${mode === "reg" ? "" : "ghost"}">حساب جديد</button>
      </div>
      <form id="authForm">
        ${mode === "reg" ? `<input id="aName" placeholder="الاسم الكامل" required>` : ""}
        <input id="aEmail" type="email" placeholder="البريد الإلكتروني" required>
        <input id="aPass" type="password" placeholder="كلمة المرور (6 أحرف على الأقل)" minlength="6" required>
        <div class="err" id="aErr"></div>
        <button type="submit" style="width:100%">${mode === "login" ? "دخول" : "إنشاء الحساب"}</button>
      </form>
    </div>`;

  document.getElementById("tLogin").onclick = () => renderAuth("login");
  document.getElementById("tReg").onclick = () => renderAuth("reg");

  document.getElementById("authForm").onsubmit = async e => {
    e.preventDefault();
    const email = document.getElementById("aEmail").value.trim();
    const password = document.getElementById("aPass").value;
    const err = document.getElementById("aErr");
    err.textContent = "";

    let res;
    if (mode === "reg") {
      const name = document.getElementById("aName").value.trim();
      res = await sb.auth.signUp({ email, password, options: { data: { name } } });
      if (!res.error && !res.data.session) {
        err.textContent = "تم إنشاء الحساب. افتح الإيميل وأكد الحساب، وبعدين ادخل.";
        return;
      }
    } else {
      res = await sb.auth.signInWithPassword({ email, password });
    }
    if (res.error) { err.textContent = translateError(res.error.message); return; }
    start();
  };
}

function translateError(msg) {
  if (msg.includes("Invalid login")) return "البريد أو كلمة المرور غير صحيحة";
  if (msg.includes("already registered")) return "البريد ده مسجل قبل كده";
  if (msg.includes("Email not confirmed")) return "لازم تأكد البريد الأول";
  if (msg.includes("Password")) return "كلمة المرور لازم تكون 6 أحرف على الأقل";
  return msg;
}

/* ---------- Shell ---------- */

async function renderApp() {
  const user = CURRENT;
  const { data: profile } = await sb.from("profiles").select("name").eq("id", user.id).single();

  userBar.innerHTML = `
    <button class="ghost ${view === "feed" ? "nav-on" : ""}" data-nav="feed">🏠</button>
    <button class="ghost ${view === "friends" ? "nav-on" : ""}" data-nav="friends">👥</button>
    <button class="ghost ${view === "people" ? "nav-on" : ""}" data-nav="people">🔎</button>
    <button class="ghost ${view === "profile" ? "nav-on" : ""}" data-nav="profile">👤</button>
    <button class="ghost ${view === "notifications" ? "nav-on" : ""}" data-nav="notifications">🔔<span id="badge" class="badge"></span></button>
    <span class="muted">${esc(profile?.name || "")}</span>
    <button class="ghost" id="logout">خروج</button>`;

  userBar.querySelectorAll("[data-nav]").forEach(b => {
    b.onclick = () => {
      view = b.dataset.nav;
      if (view === "profile") profileId = user.id;
      renderApp();
    };
  });
  document.getElementById("logout").onclick = async () => { await sb.auth.signOut(); start(); };

  updateBadge();

  if (view === "friends") return renderFriendsView(user);
  if (view === "people") return renderPeopleView(user);
  if (view === "profile") return renderProfileView(user, profileId || user.id);
  if (view === "notifications") return renderNotificationsView(user);
  return renderFeedView(user, profile?.name || "");
}

/* ---------- Notifications ---------- */

async function updateBadge() {
  if (!CURRENT) return;
  const { count } = await sb.from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", CURRENT.id)
    .eq("read", false);
  const b = document.getElementById("badge");
  if (!b) return;
  if (count) {
    b.style.display = "inline-block";
    b.textContent = count > 9 ? "9+" : String(count);
  } else {
    b.style.display = "none";
  }
}

const NOTE_TEXT = {
  friend_request: "أرسل لك طلب صداقة",
  friend_accept: "قبل طلب صداقتك",
  like: "عمل لايك على منشورك",
  comment: "علّق على منشورك"
};

async function renderNotificationsView(user) {
  app.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const { data: notes, error } = await sb.from("notifications")
    .select("id, type, actor_id, post_id, read, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) { app.innerHTML = `<div class="err">حصل خطأ: ${esc(error.message)}</div>`; return; }

  const names = await getNames([...new Set((notes || []).map(n => n.actor_id))]);

  const list = (notes || []).map(n => {
    const target = n.type.startsWith("friend") ? "friends" : "feed";
    return `
      <div class="friend-row ${n.read ? "" : "unread"}" data-go="${target}" style="cursor:pointer">
        <div>
          <b>${esc(names[n.actor_id] || "مستخدم")}</b> ${NOTE_TEXT[n.type] || ""}
          <div class="muted">${ago(n.created_at)}</div>
        </div>
      </div>`;
  }).join("");

  app.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">الإشعارات</h3>
      ${list || `<div class="muted">مفيش إشعارات لسه</div>`}
    </div>`;

  // نعلّم الكل كمقروء بعد ما نعرضهم
  await sb.from("notifications").update({ read: true }).eq("user_id", user.id).eq("read", false);
  updateBadge();
}

/* ---------- Feed ---------- */

function renderFeedView(user, name) {
  app.innerHTML = `
    <div class="card">
      <textarea id="newBody" rows="3" placeholder="بم تفكر يا ${esc((name || "").split(" ")[0])}؟"></textarea>
      <input type="file" id="newImage" accept="image/*">
      <div class="row"><span class="spacer"></span><button id="publish">نشر</button></div>
      <div class="err" id="pErr"></div>
    </div>
    <div id="feed"></div>`;

  document.getElementById("publish").onclick = () => createPost(user);
  return loadFeed(user);
}

async function loadFeed(user) {
  const feed = document.getElementById("feed");
  feed.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const rels = await getRelations(user.id);
  const friendIds = rels.filter(r => r.status === "accepted").map(r => otherId(r, user.id));

  const q = sb.from("posts")
    .select(POST_COLS)
    .in("author_id", [user.id, ...friendIds])
    .order("created_at", { ascending: false })
    .limit(30);

  return drawPosts(feed, q, user, () => loadFeed(user), "مفيش منشورات لسه. ضيف أصدقاء من تبويب 🔎 عشان تشوف منشوراتهم");
}

// يرسم قايمة منشورات في أي مكان (الفيد أو صفحة شخصية)
async function drawPosts(container, query, user, reload, emptyMsg = "مفيش منشورات لسه") {
  const { data: posts, error } = await query;
  if (error) { container.innerHTML = `<div class="err">حصل خطأ: ${esc(error.message)}</div>`; return; }
  if (!posts.length) { container.innerHTML = `<div class="card muted" style="text-align:center">${esc(emptyMsg)}</div>`; return; }

  const ids = new Set();
  posts.forEach(p => {
    ids.add(p.author_id);
    p.comments.forEach(c => ids.add(c.author_id));
  });
  const names = await getNames([...ids]);

  const { data: mine } = await sb.from("reports").select("post_id").eq("reporter_id", user.id);
  const reported = new Set((mine || []).map(r => r.post_id));

  posts.forEach(p => {
    p.authorName = names[p.author_id] || "مستخدم";
    p.reported = reported.has(p.id);
    p.comments.forEach(c => { c.authorName = names[c.author_id] || "مستخدم"; });
  });

  container.innerHTML = posts.map(p => postHTML(p, user)).join("");
  bindPosts(user, reload);
}

function postHTML(p, user) {
  const liked = p.likes.some(l => l.user_id === user.id);
  const isMine = p.author_id === user.id;

  let reportBtn = "";
  if (!isMine) {
    reportBtn = p.reported
      ? `<button class="ghost" disabled>🚩 تم الإبلاغ</button>`
      : `<button class="ghost" data-report>🚩</button>`;
  }

  return `
    <div class="card post" data-id="${p.id}">
      <div class="row">
        <div><b class="link" data-profile="${p.author_id}">${esc(p.authorName)}</b><div class="muted">${ago(p.created_at)}</div></div>
        <span class="spacer"></span>
        ${reportBtn}
        ${isMine ? `<button class="ghost" data-del>🗑</button>` : ""}
      </div>
      ${p.body ? `<div class="body">${esc(p.body)}</div>` : ""}
      ${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : ""}
      <div class="muted" style="margin-top:8px">👍 ${p.likes.length} · 💬 ${p.comments.length}</div>
      <div class="actions">
        <button class="${liked ? "on" : ""}" data-like>👍 إعجاب</button>
        <button data-focus>💬 تعليق</button>
      </div>
      ${p.comments.map(c => `<div class="comment"><b class="link" data-profile="${c.author_id}">${esc(c.authorName)}</b><div>${esc(c.body)}</div></div>`).join("")}
      <form class="row" data-cform style="margin-top:8px">
        <input placeholder="اكتب تعليقًا..." required maxlength="500" style="margin:0">
        <button>إرسال</button>
      </form>
    </div>`;
}

function bindPosts(user, reload) {
  document.querySelectorAll(".post").forEach(card => {
    const id = card.dataset.id;

    const likeBtn = card.querySelector("[data-like]");
    likeBtn.onclick = async () => {
      const liked = likeBtn.classList.contains("on");
      if (liked) {
        await sb.from("likes").delete().eq("post_id", id).eq("user_id", user.id);
      } else {
        await sb.from("likes").insert({ post_id: id, user_id: user.id });
      }
      reload();
    };

    card.querySelector("[data-focus]").onclick = () => card.querySelector("[data-cform] input").focus();

    card.querySelector("[data-cform]").onsubmit = async e => {
      e.preventDefault();
      const input = e.target.querySelector("input");
      const body = input.value.trim();
      if (!body) return;
      await sb.from("comments").insert({ post_id: id, author_id: user.id, body });
      reload();
    };

    const del = card.querySelector("[data-del]");
    if (del) del.onclick = async () => {
      if (!confirm("تحذف المنشور؟")) return;
      await sb.from("posts").delete().eq("id", id);
      reload();
    };

    const rep = card.querySelector("[data-report]");
    if (rep) rep.onclick = async () => {
      const reason = prompt("سبب الإبلاغ (اختياري):", "");
      if (reason === null) return;
      const { error } = await sb.from("reports").insert({
        post_id: id,
        reporter_id: user.id,
        reason: reason.trim().slice(0, 300) || null
      });
      if (error) {
        alert(error.code === "23505" ? "بلغت عن المنشور ده قبل كده" : "حصل خطأ: " + error.message);
        return;
      }
      alert("شكرًا، البلاغ اتسجل وهيتراجع.");
      reload();
    };
  });
}

async function createPost(user) {
  const body = document.getElementById("newBody").value.trim();
  const file = document.getElementById("newImage").files[0];
  const err = document.getElementById("pErr");
  err.textContent = "";

  if (!body && !file) { err.textContent = "اكتب حاجة أو اختار صورة"; return; }
  if (file && file.size > 5 * 1024 * 1024) { err.textContent = "الصورة أكبر من 5 ميجا"; return; }

  let image_url = null;
  if (file) {
    const path = `${user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const up = await sb.storage.from(BUCKET).upload(path, file);
    if (up.error) { err.textContent = "فشل رفع الصورة: " + up.error.message; return; }
    image_url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  const { error } = await sb.from("posts").insert({ author_id: user.id, body: body || null, image_url });
  if (error) { err.textContent = error.message; return; }
  document.getElementById("newBody").value = "";
  document.getElementById("newImage").value = "";
  loadFeed(user);
}

/* ---------- Profile page ---------- */

async function renderProfileView(user, targetId) {
  app.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const { data: prof } = await sb.from("profiles")
    .select("id, name, bio, avatar_url")
    .eq("id", targetId)
    .single();

  if (!prof) { app.innerHTML = `<div class="card muted" style="text-align:center">الصفحة دي مش موجودة</div>`; return; }

  const rels = await getRelations(user.id);
  const isMe = targetId === user.id;
  const friendCount = rels.filter(r => r.status === "accepted").length;
  const rel = rels.find(r => otherId(r, user.id) === targetId);

  app.innerHTML = `
    <div class="card profile-head" id="profileHead">
      ${avatarHTML(prof, 96)}
      <h2 style="margin:10px 0 4px">${esc(prof.name)}</h2>
      <div class="muted">${esc(prof.bio || "")}</div>
      ${isMe
        ? `<div class="muted" style="margin-top:6px">👥 ${friendCount} صديق</div>
           <div style="margin-top:10px"><button class="ghost" id="editBtn">✏️ تعديل الملف</button></div>`
        : `<div style="margin-top:10px">${relBtn(rel, targetId, user.id)}</div>`}
    </div>
    <div id="feed"></div>`;

  if (isMe) document.getElementById("editBtn").onclick = () => showEditForm(user, prof);

  const q = sb.from("posts")
    .select(POST_COLS)
    .eq("author_id", targetId)
    .order("created_at", { ascending: false })
    .limit(30);

  return drawPosts(document.getElementById("feed"), q, user,
    () => renderProfileView(user, targetId), "مفيش منشورات لسه");
}

function showEditForm(user, prof) {
  const head = document.getElementById("profileHead");
  head.innerHTML = `
    <form id="editForm">
      <input id="eName" value="${esc(prof.name)}" required maxlength="50" placeholder="الاسم">
      <textarea id="eBio" rows="2" maxlength="160" placeholder="نبذة قصيرة">${esc(prof.bio || "")}</textarea>
      <div class="muted" style="text-align:right">صورة البروفايل (اختياري):</div>
      <input type="file" id="eAvatar" accept="image/*">
      <div class="err" id="eErr"></div>
      <div class="row" style="justify-content:center">
        <button class="ghost" type="button" id="eCancel">إلغاء</button>
        <button type="submit">حفظ</button>
      </div>
    </form>`;

  document.getElementById("eCancel").onclick = () => renderProfileView(user, user.id);

  document.getElementById("editForm").onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById("eErr");
    err.textContent = "";

    const name = document.getElementById("eName").value.trim();
    const bio = document.getElementById("eBio").value.trim();
    const file = document.getElementById("eAvatar").files[0];

    if (!name) { err.textContent = "الاسم مطلوب"; return; }
    if (file && file.size > 5 * 1024 * 1024) { err.textContent = "الصورة أكبر من 5 ميجا"; return; }

    const update = { name, bio };

    if (file) {
      const path = `${user.id}/avatar-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const up = await sb.storage.from(BUCKET).upload(path, file);
      if (up.error) { err.textContent = "فشل رفع الصورة: " + up.error.message; return; }
      update.avatar_url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }

    const { error } = await sb.from("profiles").update(update).eq("id", user.id);
    if (error) { err.textContent = error.message; return; }
    renderApp();
  };
}

/* ---------- Friends tab ---------- */

async function renderFriendsView(user) {
  app.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const rows = await getRelations(user.id);
  const names = await getNames(rows.map(r => otherId(r, user.id)));

  const incoming = rows.filter(r => r.status === "pending" && r.addressee_id === user.id);
  const outgoing = rows.filter(r => r.status === "pending" && r.requester_id === user.id);
  const friends = rows.filter(r => r.status === "accepted");

  const line = (r, buttons) => {
    const o = otherId(r, user.id);
    return `<div class="friend-row">
      <b class="link" data-profile="${o}">${esc(names[o] || "مستخدم")}</b>
      <span class="spacer"></span>
      ${buttons(o)}
    </div>`;
  };

  app.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">طلبات واردة (${incoming.length})</h3>
      ${incoming.length
        ? incoming.map(r => line(r, o => `<button data-act="accept" data-id="${o}">قبول</button>
            <button class="ghost" data-act="remove" data-id="${o}">رفض</button>`)).join("")
        : `<div class="muted">مفيش طلبات جديدة</div>`}
    </div>
    <div class="card">
      <h3 style="margin-top:0">أصدقائي (${friends.length})</h3>
      ${friends.length
        ? friends.map(r => line(r, o => `<button class="ghost" data-act="remove" data-id="${o}">حذف الصداقة</button>`)).join("")
        : `<div class="muted">لسه معندكش أصدقاء. ابعت طلبات من تبويب 🔎</div>`}
    </div>
    <div class="card">
      <h3 style="margin-top:0">طلبات مرسلة (${outgoing.length})</h3>
      ${outgoing.length
        ? outgoing.map(r => line(r, o => `<button class="ghost" data-act="remove" data-id="${o}">إلغاء الطلب</button>`)).join("")
        : `<div class="muted">مفيش طلبات مرسلة</div>`}
    </div>`;
}

/* ---------- People tab ---------- */

async function renderPeopleView(user) {
  app.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const { data: people } = await sb.from("profiles")
    .select("id, name, bio, avatar_url")
    .neq("id", user.id)
    .order("name");

  const rows = await getRelations(user.id);
  const rel = {};
  rows.forEach(r => { rel[otherId(r, user.id)] = r; });

  const list = (people || []).map(p => `
    <div class="friend-row">
      ${avatarHTML(p, 40)}
      <div>
        <b class="link" data-profile="${p.id}">${esc(p.name)}</b>
        <div class="muted">${esc(p.bio || "")}</div>
      </div>
      <span class="spacer"></span>
      ${relBtn(rel[p.id], p.id, user.id)}
    </div>`).join("");

  app.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">أشخاص على وجوه</h3>
      ${list || `<div class="muted">مفيش مستخدمين تانيين لسه</div>`}
    </div>`;
}

/* ---------- Delegated clicks ---------- */

app.addEventListener("click", async e => {
  const go = e.target.closest("[data-go]");
  if (go && CURRENT) {
    view = go.dataset.go;
    renderApp();
    return;
  }

  const pr = e.target.closest("[data-profile]");
  if (pr && CURRENT) {
    view = "profile";
    profileId = pr.dataset.profile;
    renderApp();
    return;
  }

  const b = e.target.closest("[data-act]");
  if (!b || !CURRENT) return;

  const me = CURRENT.id;
  const other = b.dataset.id;
  const act = b.dataset.act;

  if (act === "add") {
    await sb.from("friendships").insert({ requester_id: me, addressee_id: other, status: "pending" });
  } else if (act === "accept") {
    await sb.from("friendships").update({ status: "accepted" })
      .eq("requester_id", other).eq("addressee_id", me);
  } else if (act === "remove") {
    await sb.from("friendships").delete()
      .or(`and(requester_id.eq.${me},addressee_id.eq.${other}),and(requester_id.eq.${other},addressee_id.eq.${me})`);
  }

  renderApp();
});

/* ---------- Start ---------- */

async function start() {
  const { data } = await sb.auth.getUser();
  CURRENT = data?.user || null;
  if (CURRENT) {
    view = "feed";
    profileId = null;
    renderApp();
    if (!badgeTimer) badgeTimer = setInterval(updateBadge, 30000);
  } else {
    renderAuth("login");
  }
}

sb.auth.onAuthStateChange(event => {
  if (event === "SIGNED_OUT") {
    CURRENT = null;
    clearInterval(badgeTimer);
    badgeTimer = null;
    renderAuth("login");
  }
});

start();
