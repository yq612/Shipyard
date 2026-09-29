/* =========================================================
   磷光 Phosphor 主题切换 v1.2

   用法：在 <head> 里、样式表前面同步引入（不要加 async / defer）：
     <script src="phosphor-theme.js"></script>

   切换按钮：给任意按钮加 data-theme-set="auto" / "dark" / "light"，
   脚本会自动绑定点击，并同步更新 aria-pressed。

   选择会存进 localStorage（键名 phosphor-theme）；选 auto 就是跟随系统。
   每次换主题，document 上会发出 phosphor:themechange 事件。
   ========================================================= */
(function () {
  var KEY = 'phosphor-theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  var current = read();

  function resolve(pref) {
    if (pref === 'dark' || pref === 'light') return pref;
    return media && media.matches ? 'light' : 'dark';
  }

  function syncButtons() {
    var btns = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-theme-set') === current));
    }
  }

  // Chrome 有时换了主题不马上重画自定义滚动条，要等鼠标移上去才变色。
  // 这里把页面滚动条关掉再打开一次，强制重画。同一帧内完成，看不出闪动，滚动位置也不变
  function repaintScrollbar() {
    var prev = root.style.overflow;
    root.style.overflow = 'hidden';
    void root.offsetWidth;
    root.style.overflow = prev;
  }

  function apply() {
    var theme = resolve(current);
    // 换色瞬间先关掉过渡，整页同时变色，不会有按钮慢半拍
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', theme);
    repaintScrollbar();
    syncButtons();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.remove('theme-switching'); });
    });
    document.dispatchEvent(new CustomEvent('phosphor:themechange', { detail: { pref: current, theme: theme } }));
  }

  function set(pref) {
    current = pref === 'dark' || pref === 'light' ? pref : 'auto';
    try {
      if (current === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, current);
    } catch (e) {}
    apply();
  }

  // 1. 立刻执行：页面画出来之前就定好主题，打开时不会闪
  root.setAttribute('data-theme', resolve(current));

  // 2. 跟随系统时，系统切换深浅色，页面也跟着变
  if (media) {
    var onSystemChange = function () { if (current === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // 3. 其他标签页改了主题，这里同步
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { current = read(); apply(); }
  });

  // 4. 页面加载完再绑定按钮
  function bind() {
    syncButtons();
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-theme-set]');
      if (btn) set(btn.getAttribute('data-theme-set'));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.phosphorTheme = { set: set, get: function () { return current; } };
})();
