const { SUPABASE_URL, SUPABASE_KEY, BUCKET } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const app = document.getElementById("app");
const userBar = document.getElementById("userBar");

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

async function currentUser() {
  const { data } = await sb.auth.getUser();
  return data.user;
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

/* ---------- Feed ---------- */

async function renderFeed(user) {
  const { data: profile } = await sb.from("profiles").select("name").eq("id", user.id).single();
  userBar.innerHTML = `<span class="muted">${esc(profile?.name || "")}</span>
    <button class="ghost" id="logout">خروج</button>`;
  document.getElementById("logout").onclick = async () => { await sb.auth.signOut(); start(); };

  app.innerHTML = `
    <div class="card">
      <textarea id="newBody" rows="3" placeholder="بم تفكر يا ${esc((profile?.name || "").split(" ")[0])}؟"></textarea>
      <input type="file" id="newImage" accept="image/*">
      <div class="row"><span class="spacer"></span><button id="publish">نشر</button></div>
      <div class="err" id="pErr"></div>
    </div>
    <div id="feed"></div>`;

  document.getElementById("publish").onclick = () => createPost(user);
  await loadFeed(user);
}

async function loadFeed(user) {
  const feed = document.getElementById("feed");
  feed.innerHTML = `<div class="muted" style="text-align:center">جاري التحميل...</div>`;

  const { data, error } = await sb.from("posts")
    .select("id, body, image_url, created_at, author_id, author:profiles(name), likes(user_id), comments(id, body, created_at, author:profiles(name))")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) { feed.innerHTML = `<div class="err">حصل خطأ: ${esc(error.message)}</div>`; return; }
  if (!data.length) { feed.innerHTML = `<div class="card muted" style="text-align:center">مفيش منشورات لسه، اكتب أول منشور!</div>`; return; }

  feed.innerHTML = data.map(p => postHTML(p, user)).join("");
  bindPosts(user);
}

function postHTML(p, user) {
  const liked = p.likes.some(l => l.user_id === user.id);
  return `
    <div class="card post" data-id="${p.id}">
      <div class="row">
        <div><b>${esc(p.author?.name || "مستخدم")}</b><div class="muted">${ago(p.created_at)}</div></div>
        <span class="spacer"></span>
        ${p.author_id === user.id ? `<button class="ghost" data-del>🗑</button>` : ""}
      </div>
      ${p.body ? `<div class="body">${esc(p.body)}</div>` : ""}
      ${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : ""}
      <div class="muted" style="margin-top:8px">👍 ${p.likes.length} · 💬 ${p.comments.length}</div>
      <div class="actions">
        <button class="${liked ? "on" : ""}" data-like>👍 إعجاب</button>
        <button data-focus>💬 تعليق</button>
      </div>
      ${p.comments.map(c => `<div class="comment"><b>${esc(c.author?.name || "مستخدم")}</b><div>${esc(c.body)}</div></div>`).join("")}
      <form class="row" data-cform style="margin-top:8px">
        <input placeholder="اكتب تعليقًا..." required maxlength="500" style="margin:0">
        <button>إرسال</button>
      </form>
    </div>`;
}

function bindPosts(user) {
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
      loadFeed(user);
    };

    card.querySelector("[data-focus]").onclick = () => card.querySelector("[data-cform] input").focus();

    card.querySelector("[data-cform]").onsubmit = async e => {
      e.preventDefault();
      const input = e.target.querySelector("input");
      const body = input.value.trim();
      if (!body) return;
      await sb.from("comments").insert({ post_id: id, author_id: user.id, body });
      loadFeed(user);
    };

    const del = card.querySelector("[data-del]");
    if (del) del.onclick = async () => {
      if (!confirm("تحذف المنشور؟")) return;
      await sb.from("posts").delete().eq("id", id);
      loadFeed(user);
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

/* ---------- Start ---------- */

async function start() {
  const user = await currentUser();
  if (user) renderFeed(user);
  else renderAuth("login");
}

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") renderAuth("login");
});

start();
