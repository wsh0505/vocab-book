/* =============================================================
 * app.js —— 界面与交互
 * 首页：横向书架（滑动选择，中间的书抬起）
 * 其他：词书详情、背单词、复习、练习、封面编辑、设置
 * ============================================================= */
(function (global) {
    'use strict';

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

    /** HTML 转义 */
    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 应用状态 */
    const state = {
        view: 'home',
        bookId: null,
        focusBookId: null,   // 书架上居中的书
        search: '',
        study: null,         // { mode, bookId, queue, index, showAnswer, finished }
        lastAction: null,    // 最近一次答题，用于撤销
        libFilter: 'all',    // 单词库筛选：all | new | learning | due | overdue | mastered
        libSort: 'order',    // 单词库排序：order | alpha | recent | stage
        continueBookId: null // 首页「继续学习」指向的词书
    };

    let deferredPrompt = null;   // PWA 安装事件（Android Chrome）
    let shelfResizeHandler = null;

    /* =========================================================
     * 主题与字体
     * ========================================================= */

    function applyTheme() {
        const setting = Store.getSettings().theme;
        let resolved = setting;
        if (setting === 'system') {
            const dark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
            resolved = dark ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', resolved);
        const meta = $('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute('content', resolved === 'dark' ? '#16171a' : '#f4f1ea');
        }
    }

    function applyFontScale() {
        const scale = Store.getSettings().fontScale || 1;
        document.documentElement.style.fontSize = Math.round(16 * scale) + 'px';
    }

    /* =========================================================
     * 通用组件
     * ========================================================= */

    function toast(message) {
        const root = document.getElementById('toast-root');
        const node = document.createElement('div');
        node.className = 'toast';
        node.textContent = message;
        root.appendChild(node);
        setTimeout(() => node.remove(), 1900);
    }

    /**
     * 打开弹窗
     * @param {Object} opts { title, body, actions, onMount, dismissible }
     */
    function openModal(opts) {
        const root = document.getElementById('modal-root');
        const mask = document.createElement('div');
        mask.className = 'modal-mask';
        mask.innerHTML =
            '<div class="modal">' +
                '<div class="modal-header">' + esc(opts.title) + '</div>' +
                '<div class="modal-body">' + (opts.body || '') + '</div>' +
                '<div class="modal-footer"></div>' +
            '</div>';

        const footer = $('.modal-footer', mask);
        (opts.actions || []).forEach((action) => {
            const btn = document.createElement('button');
            btn.className = 'btn ' + (action.className || '');
            btn.textContent = action.label;
            btn.addEventListener('click', () => {
                if (action.onClick) {
                    action.onClick(close, btn);
                } else {
                    close();
                }
            });
            footer.appendChild(btn);
        });

        function close() {
            mask.remove();
        }

        if (opts.dismissible !== false) {
            mask.addEventListener('click', (event) => {
                if (event.target === mask) {
                    close();
                }
            });
        }

        root.appendChild(mask);
        if (opts.onMount) {
            opts.onMount(mask, close);
        }
        return close;
    }

    /** 确认弹窗 */
    function confirmDialog(title, message, onOk) {
        openModal({
            title: title,
            body: '<div style="padding:4px 0 10px;line-height:1.7;">' + esc(message) + '</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                { label: '确定', className: 'btn-danger', onClick: (close) => { close(); onOk(); } }
            ]
        });
    }

    /** 长按：长按触发 onLongPress，普通点击触发 onClick */
    function bindLongPress(el, onLongPress, onClick) {
        let timer = null;
        let startX = 0;
        let startY = 0;
        let moved = false;
        let longFired = false;
        let suppressClick = false;

        el.addEventListener('pointerdown', (event) => {
            startX = event.clientX;
            startY = event.clientY;
            moved = false;
            longFired = false;
            clearTimeout(timer);
            timer = setTimeout(() => {
                longFired = true;
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 420);
                if (global.navigator.vibrate) {
                    global.navigator.vibrate(12);
                }
                onLongPress();
            }, 500);
        });

        el.addEventListener('pointermove', (event) => {
            if (!timer) {
                return;
            }
            if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
                moved = true;
                clearTimeout(timer);
                timer = null;
            }
        });

        el.addEventListener('pointerup', () => {
            clearTimeout(timer);
            timer = null;
            if (!longFired && !moved) {
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 380);
                onClick();
            }
        });

        el.addEventListener('pointercancel', () => {
            clearTimeout(timer);
            timer = null;
        });

        el.addEventListener('click', () => {
            if (suppressClick) {
                return;
            }
            onClick();
        });

        el.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    /* =========================================================
     * 首页数据汇总（今日概览 / 本周趋势）
     * ========================================================= */

    const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    /** 是否算「已掌握」 */
    function isMastered(word) {
        return word.status === 'mastered' || word.stage >= Schedule.MAX_STAGE;
    }

    /** 今天是否需要复习（含逾期） */
    function isDueWord(word, now) {
        return word.stage >= 0 && word.nextReview !== null && Schedule.overdueDays(word, now) >= 0;
    }

    /** 是否已经逾期（至少晚了一天） */
    function isOverdueWord(word, now) {
        return word.stage >= 0 && word.nextReview !== null && Schedule.overdueDays(word, now) > 0;
    }

    /** 全部词书的今日汇总 */
    function todaySummary() {
        const books = Store.getBooks();
        const now = Date.now();
        const sum = {
            totalBooks: books.length,
            total: 0,
            learned: 0,
            dueCount: 0,
            overdueCount: 0,
            todayNew: 0,
            todayReviewed: 0
        };
        books.forEach((book) => {
            const stats = Schedule.stats(book, now);
            sum.total += stats.total;
            sum.learned += stats.learned;
            sum.dueCount += stats.dueCount;
            sum.overdueCount += stats.overdueCount;
            sum.todayNew += stats.todayNew;
            sum.todayReviewed += stats.todayReviewed;
        });
        return sum;
    }

    /** 最近 7 天每天的新学 + 复习数量（没有数据的日子就是 0，不伪造） */
    function weekTrend() {
        const books = Store.getBooks();
        const base = Utils.startOfDay(Date.now());
        const days = [];
        for (let i = 6; i >= 0; i -= 1) {
            const ts = base - i * 86400000;
            const key = Utils.dateKey(ts);
            let newLearned = 0;
            let reviewed = 0;
            books.forEach((book) => {
                const daily = book.dailyLog[key];
                if (daily) {
                    newLearned += daily.newLearned || 0;
                    reviewed += daily.reviewed || 0;
                }
            });
            const date = new Date(ts);
            days.push({
                key: key,
                newLearned: newLearned,
                reviewed: reviewed,
                total: newLearned + reviewed,
                isToday: i === 0,
                weekday: WEEKDAY_TEXT[date.getDay()],
                md: (date.getMonth() + 1) + '/' + date.getDate()
            });
        }
        return days;
    }

    /** 最近真正学过（复习或新学）的那本词书，没有就返回 null */
    function lastActiveBook() {
        let best = null;
        let bestTs = 0;
        Store.getBooks().forEach((book) => {
            let ts = 0;
            book.words.forEach((word) => {
                ts = Math.max(ts, word.lastReviewAt || 0, word.learnedAt || 0);
            });
            if (ts > bestTs) {
                bestTs = ts;
                best = book;
            }
        });
        return bestTs > 0 ? best : null;
    }

    /**
     * 今天该学哪一本：待复习最多的优先，其次还有新词的，同分时倾向最近学过的那本
     * 一本都没有时返回 null
     */
    function pickTodayBook() {
        const books = Store.getBooks();
        if (books.length === 0) {
            return null;
        }
        const now = Date.now();
        const active = lastActiveBook();
        let best = null;
        let bestScore = -1;
        books.forEach((book) => {
            const stats = Schedule.stats(book, now);
            let score = stats.dueCount * 10 + (stats.unlearned > 0 ? 2 : 0);
            if (active && book.id === active.id) {
                score += 0.5;   // 只用于打平时的偏好，不会盖过真正有待复习的书
            }
            if (score > bestScore) {
                bestScore = score;
                best = book;
            }
        });
        return best;
    }

    /** 中文日期，例如「10月21日 · 周三」 */
    function chineseDateText(now) {
        const date = new Date(now);
        return (date.getMonth() + 1) + '月' + date.getDate() + '日 · ' + WEEKDAY_TEXT[date.getDay()];
    }

    /* =========================================================
     * 首页：横向书架
     * ========================================================= */

    function renderHome() {
        const books = Store.getBooks();
        const now = Date.now();

        const slots = books.map((book) => {
            const stats = Schedule.stats(book, now);
            const percent = stats.total === 0 ? 0 : Math.round(stats.learned / stats.total * 100);
            const tag = stats.dueCount > 0
                ? '<div class="cover-tag">今日待复习 ' + stats.dueCount + '</div>'
                : '';
            return '' +
                '<div class="book-slot" data-id="' + book.id + '">' +
                    '<div class="book-cover" style="' + Cover.style(book.cover) + '">' +
                        '<div class="cover-inner">' +
                            '<div class="cover-title">' + esc(book.name) + '</div>' +
                            '<div class="cover-foot">' +
                                '<div class="cover-num">' + stats.learned + ' / ' + stats.total + ' 已学</div>' +
                                '<div class="cover-bar"><i style="width:' + percent + '%"></i></div>' +
                                tag +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
        }).join('');

        const tip = books.length === 0
            ? '书架上还没有单词书<br>点击右边的「新建」放上第一本'
            : '左右滑动选书 · 点击中间那本打开<br>长按封面可重命名、换封面或删除';

        $('#app').innerHTML =
            '<div class="topbar">' +
                '<div class="topbar-title">单词书架</div>' +
                '<button class="icon-btn" id="btn-settings" title="设置">⚙</button>' +
            '</div>' +
            '<div class="page">' +
                '<div class="shelf-head">' +
                    '<div class="shelf-head-title">我的书架</div>' +
                    '<div class="shelf-head-sub">共 ' + books.length + ' 本</div>' +
                '</div>' +
                '<div class="shelf">' +
                    '<div class="shelf-scroll" id="shelf-scroll">' +
                        slots +
                        '<div class="add-slot" id="add-slot">' +
                            '<div class="add-plus">＋</div>' +
                            '<div class="add-text">新建</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="shelf-board"></div>' +
                '<div class="shelf-tip">' + tip + '</div>' +
                '<div class="dash-grid">' +
                    todayCard() +
                    weekCard() +
                '</div>' +
                continueCard() +
            '</div>';

        $('#btn-settings').addEventListener('click', openSettings);
        $('#add-slot').addEventListener('click', promptCreateBook);
        const todayBtn = $('#btn-today');
        if (todayBtn) {
            todayBtn.addEventListener('click', startToday);
        }
        const contBtn = $('#btn-continue');
        if (contBtn) {
            contBtn.addEventListener('click', () => {
                openBook(state.continueBookId);
            });
        }
        setupShelf();
    }

    /** 首页「今日学习」卡片 */
    function todayCard() {
        const summary = todaySummary();
        const now = Date.now();
        const books = Store.getBooks();
        if (books.length === 0) {
            return '<div class="card dash-card">' +
                        '<div class="card-head">' +
                            '<div class="card-title">今日学习</div>' +
                            '<div class="card-sub">' + chineseDateText(Date.now()) + '</div>' +
                        '</div>' +
                        '<div class="today-empty">放上第一本单词书，就可以开始今天的学习了。</div>' +
                        '<button class="btn btn-primary btn-block btn-lg" id="btn-today">新建单词书</button>' +
                   '</div>';
        }

        const goal = Store.getSettings().dailyGoal || 20;
        const doneToday = summary.todayNew + summary.todayReviewed;
        const percent = goal > 0 ? Math.min(100, Math.round(doneToday / goal * 100)) : 0;

        let hint;
        if (summary.dueCount > 0) {
            hint = '今天有 ' + summary.dueCount + ' 个到期单词' +
                (summary.overdueCount > 0 ? '，其中 ' + summary.overdueCount + ' 个已经逾期' : '，先复习再背新词效果更好');
        } else if (summary.todayNew + summary.todayReviewed > 0) {
            hint = '今天的任务已经完成了，有空的话可以再背几个新词。';
        } else {
            hint = '今天没有到期的复习任务，直接背新词也可以。';
        }

        const dueClass = summary.dueCount > 0 ? ' accent' : '';
        const overdueLine = summary.overdueCount > 0
            ? '<div class="today-hint warn">有 ' + summary.overdueCount + ' 个单词已经逾期，建议先处理它们。</div>'
            : '';

        return '<div class="card dash-card today-card">' +
                    '<div class="card-head">' +
                        '<div class="card-title">今日学习</div>' +
                        '<div class="card-sub">' + chineseDateText(now) + '</div>' +
                    '</div>' +
                    '<div class="today-stats">' +
                        '<div class="today-stat' + dueClass + '">' +
                            '<div class="today-num">' + summary.dueCount + '</div>' +
                            '<div class="today-label">今日待复习</div>' +
                        '</div>' +
                        '<div class="today-stat">' +
                            '<div class="today-num">' + summary.todayNew + '</div>' +
                            '<div class="today-label">今日新学</div>' +
                        '</div>' +
                        '<div class="today-stat">' +
                            '<div class="today-num">' + summary.todayReviewed + '</div>' +
                            '<div class="today-label">今日已复习</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="today-bar"><i style="width:' + percent + '%"></i></div>' +
                    '<div class="today-goal">今天已完成 ' + doneToday + ' / 目标 ' + goal +
                        ' 个 · ' + percent + '%</div>' +
                    '<div class="today-hint">' + esc(hint) + '</div>' +
                    overdueLine +
                    '<button class="btn btn-primary btn-block btn-lg" id="btn-today">' +
                        (doneToday > 0 ? '继续今日学习' : '开始今日学习') +
                    '</button>' +
                '</div>';
    }

    /** 首页「本周学习趋势」卡片：最近 7 天真实数据 */
    function weekCard() {
        const trend = weekTrend();
        const trendTotal = trend.reduce((sum, day) => sum + day.total, 0);
        const max = Math.max.apply(null, trend.map((day) => day.total).concat([1]));

        const cols = trend.map((day) => {
            const height = day.total > 0 ? Math.max(9, Math.round(day.total / max * 100)) : 0;
            const newShare = day.total > 0 ? Math.round(day.newLearned / day.total * 100) : 0;
            const bar = day.total > 0
                ? '<div class="week-bar" style="height:' + height + '%">' +
                      '<i class="wk-rev" style="height:' + (100 - newShare) + '%"></i>' +
                      '<i class="wk-new" style="height:' + newShare + '%"></i>' +
                  '</div>'
                : '<div class="week-bar week-bar-empty"></div>';
            return '<div class="week-col' + (day.isToday ? ' today' : '') + '" title="' +
                        day.md + ' 新学 ' + day.newLearned + ' 个 · 复习 ' + day.reviewed + ' 个">' +
                        '<div class="week-bar-wrap">' + bar + '</div>' +
                        '<div class="week-num">' + (day.total > 0 ? day.total : '') + '</div>' +
                        '<div class="week-label">' + (day.isToday ? '今天' : day.weekday) + '</div>' +
                    '</div>';
        }).join('');

        const foot = trendTotal > 0
            ? '<div class="week-legend">' +
                  '<span class="lg"><i class="dot new"></i>新学</span>' +
                  '<span class="lg"><i class="dot rev"></i>复习</span>' +
                  '<span class="week-total">最近 7 天共 ' + trendTotal + ' 个</span>' +
              '</div>'
            : '<div class="week-legend">' +
                  '<span class="week-total">最近 7 天还没有学习记录，背完今天就会显示在这里。</span>' +
              '</div>';

        return '<div class="card dash-card week-card">' +
                    '<div class="card-head">' +
                        '<div class="card-title">本周学习趋势</div>' +
                        '<div class="card-sub">最近 7 天</div>' +
                    '</div>' +
                    '<div class="week-chart">' + cols + '</div>' +
                    foot +
                '</div>';
    }

    /** 首页「继续学习」卡片：没有学习历史时不显示 */
    function continueCard() {
        const book = lastActiveBook();
        if (!book) {
            return '';
        }
        const stats = Schedule.stats(book, Date.now());
        let desc;
        if (stats.dueCount > 0) {
            desc = '还有 ' + stats.dueCount + ' 个单词待复习' +
                (stats.overdueCount > 0 ? '（' + stats.overdueCount + ' 个已逾期）' : '');
        } else if (stats.unlearned > 0) {
            desc = '还有 ' + stats.unlearned + ' 个新词没背';
        } else {
            desc = '已学 ' + stats.learned + ' / ' + stats.total + ' 个单词';
        }
        state.continueBookId = book.id;
        return '<button type="button" class="card entry-card continue-card" id="btn-continue">' +
                    '<div class="entry-main">' +
                        '<div class="entry-title">继续学习《' + esc(book.name) + '》</div>' +
                        '<div class="entry-desc">' + esc(desc) + '</div>' +
                    '</div>' +
                    '<div class="entry-arrow">›</div>' +
                '</button>';
    }

    /** 书架滚动与「抬起」效果 */
    function setupShelf() {
        const shelf = $('#shelf-scroll');
        if (!shelf) {
            return;
        }
        const slots = $$('.book-slot', shelf);
        let timer = null;
        let lifted = null;
        let geo = [];   // 缓存每本书的位置，滚动时只读 scrollLeft，避免反复触发重排

        function measure() {
            geo = slots.map((slot) => ({
                slot: slot,
                left: slot.offsetLeft,
                width: slot.offsetWidth
            }));
        }

        /** 某本书离容器中心的距离 */
        function centerDist(slot) {
            const center = shelf.scrollLeft + shelf.clientWidth / 2;
            return Math.abs((slot.offsetLeft + slot.offsetWidth / 2) - center);
        }

        /** 是否已经基本居中（用于判断是否可以直接打开） */
        function isCentered(slot) {
            return centerDist(slot) < Math.max(20, slot.offsetWidth * 0.4);
        }

        /** 只在抬起目标真正变化时才动 class，避免无谓重排 */
        function setLifted(slot) {
            if (lifted === slot) {
                return;
            }
            if (lifted) {
                lifted.classList.remove('lifted');
            }
            lifted = slot;
            if (lifted) {
                lifted.classList.add('lifted');
                state.focusBookId = lifted.getAttribute('data-id');
            }
        }

        function update() {
            if (!shelf.isConnected) {
                return;
            }
            if (geo.length === 0) {
                measure();
            }
            const center = shelf.scrollLeft + shelf.clientWidth / 2;
            let best = null;
            let bestDist = Infinity;

            geo.forEach((item) => {
                const delta = (item.left + item.width / 2) - center;
                const dist = Math.abs(delta);
                const t = Math.min(dist / (item.width * 1.25), 1).toFixed(2);
                if (item.slot.style.getPropertyValue('--t') !== t) {
                    item.slot.style.setProperty('--t', t);
                }
                item.slot.style.setProperty('--dir', delta > 0 ? 1 : -1);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = item.slot;
                }
            });

            clearTimeout(timer);
            timer = setTimeout(() => setLifted(best), 130);
        }

        let alignTimer = null;

        function scrollToSlot(slot, smooth) {
            if (!slot) {
                return;
            }
            const left = slot.offsetLeft - (shelf.clientWidth - slot.offsetWidth) / 2;
            if (smooth && shelf.scrollTo) {
                const from = shelf.scrollLeft;
                shelf.scrollTo({ left: left, behavior: 'smooth' });
                // 兜底：个别浏览器不执行平滑滚动时，直接对齐到目标位置
                clearTimeout(alignTimer);
                alignTimer = setTimeout(() => {
                    if (Math.abs(shelf.scrollLeft - from) < 1) {
                        shelf.scrollLeft = left;
                        update();
                    }
                }, 450);
            } else {
                shelf.scrollLeft = left;
            }
            update();
        }

        let liftTimer = null;

        slots.forEach((slot) => {
            const bookId = slot.getAttribute('data-id');
            bindLongPress(
                slot,
                () => openBookMenu(bookId),
                () => {
                    // 实时判断居中，不依赖 130ms 后才加上的 lifted 类
                    if (isCentered(slot)) {
                        openBookWithTransition(bookId, slot);
                        return;
                    }
                    scrollToSlot(slot, true);
                    // 兜底：点了哪本就以哪本为准，即使平滑滚动的事件没送达到位
                    clearTimeout(liftTimer);
                    liftTimer = setTimeout(() => setLifted(slot), 420);
                }
            );
        });

        // 同步更新：不套 requestAnimationFrame，避免页面被浏览器节流时收不到更新
        shelf.addEventListener('scroll', update, { passive: true });
        // 兜底：滚动彻底结束、手指离开时各补一次，防止最后一次 scroll 丢失
        shelf.addEventListener('scrollend', update, { passive: true });
        shelf.addEventListener('touchend', update, { passive: true });
        shelf.addEventListener('pointerup', update, { passive: true });

        // 每次重渲染都换掉旧的 resize 监听，避免越积越多
        if (shelfResizeHandler) {
            global.removeEventListener('resize', shelfResizeHandler);
        }
        shelfResizeHandler = () => {
            measure();
            update();
        };
        global.addEventListener('resize', shelfResizeHandler);

        global.requestAnimationFrame(() => {
            const target = slots.filter((slot) => slot.getAttribute('data-id') === state.focusBookId)[0];
            scrollToSlot(target || slots[0], false);
            // 首次进入时 scroll 事件可能不触发，直接把中间那本抬起来
            setTimeout(() => {
                if (geo.length === 0) {
                    measure();
                }
                const center = shelf.scrollLeft + shelf.clientWidth / 2;
                let best = null;
                let bestDist = Infinity;
                geo.forEach((item) => {
                    const dist = Math.abs((item.left + item.width / 2) - center);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = item.slot;
                    }
                });
                setLifted(best);
            }, 160);
        });
    }

    /** 点击中间的书：封面轻微放大后进入详情页 */
    function openBookWithTransition(bookId, slot) {
        const cover = slot ? slot.querySelector('.book-cover') : null;

        if (cover) {
            // 封面带 transform，getBoundingClientRect 是变换后的框；
            // 这里用布局尺寸 + 视觉中心定位，克隆才不会跳位
            const rect = cover.getBoundingClientRect();
            const w = cover.offsetWidth;
            const h = cover.offsetHeight;
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            const clone = cover.cloneNode(true);
            clone.className = cover.className + ' cover-clone';
            clone.style.left = (cx - w / 2) + 'px';
            clone.style.top = (cy - h / 2) + 'px';
            clone.style.width = w + 'px';
            clone.style.height = h + 'px';
            clone.style.borderRadius = '4px 12px 12px 4px';
            clone.style.transform = 'none';
            clone.style.filter = 'none';
            clone.style.boxShadow = '0 22px 38px rgba(48, 42, 30, 0.3)';
            document.body.appendChild(clone);
            global.requestAnimationFrame(() => {
                clone.style.transform = 'scale(1.14)';
                clone.style.opacity = '0';
            });
            setTimeout(() => clone.remove(), 340);
        }

        state.bookId = bookId;
        state.focusBookId = bookId;
        state.search = '';
        state.view = 'book';
        render(true);
    }

    /** 直接打开某本词书（跳过封面动画，用于「继续学习」这类入口） */
    function openBook(bookId) {
        state.bookId = bookId;
        state.focusBookId = bookId;
        state.search = '';
        state.view = 'book';
        render(true);
    }

    function promptCreateBook() {
        openModal({
            title: '新建单词书',
            body: '<div class="field">' +
                    '<label class="field-label">单词书名称</label>' +
                    '<input class="field-input" id="book-name" placeholder="例如：六级核心词汇" autocomplete="off">' +
                  '</div>' +
                  '<div class="field-hint">创建后可以先背单词，之后长按封面随时换封面。</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                {
                    label: '创建',
                    className: 'btn-primary',
                    onClick: (close) => {
                        const value = $('#book-name').value.trim();
                        if (!value) {
                            toast('请输入单词书名称');
                            return;
                        }
                        const book = Store.createBook(value);
                        state.focusBookId = book.id;
                        close();
                        render(true);
                        toast('已创建「' + value + '」');
                    }
                }
            ],
            onMount: (mask) => {
                setTimeout(() => $('#book-name', mask).focus(), 60);
            }
        });
    }

    /* =========================================================
     * 单词书菜单：重命名 / 换封面 / 删除
     * ========================================================= */

    function openBookMenu(bookId) {
        const book = Store.getBook(bookId);
        if (!book) {
            return;
        }
        openModal({
            title: book.name,
            body:
                '<button class="btn btn-block btn-lg" id="menu-rename" style="margin-bottom:10px;">重命名</button>' +
                '<button class="btn btn-block btn-lg" id="menu-cover" style="margin-bottom:10px;">更换封面</button>' +
                '<button class="btn btn-block btn-lg btn-danger" id="menu-delete">删除单词书</button>' +
                '<div class="field-hint" style="margin-top:12px;">删除后，这本书里的 ' +
                    book.words.length + ' 个单词和复习记录会一起删除。</div>',
            actions: [{ label: '关闭', onClick: (close) => close() }],
            onMount: (mask, close) => {
                $('#menu-rename', mask).addEventListener('click', () => {
                    close();
                    promptRenameBook(bookId);
                });
                $('#menu-cover', mask).addEventListener('click', () => {
                    close();
                    openCoverEditor(bookId);
                });
                $('#menu-delete', mask).addEventListener('click', () => {
                    close();
                    confirmDialog('删除单词书', '确定删除「' + book.name + '」吗？此操作不可恢复。', () => {
                        Store.deleteBook(bookId);
                        if (state.focusBookId === bookId) {
                            state.focusBookId = null;
                        }
                        toast('已删除');
                        goHome();
                    });
                });
            }
        });
    }

    function promptRenameBook(bookId) {
        const book = Store.getBook(bookId);
        if (!book) {
            return;
        }
        openModal({
            title: '重命名',
            body: '<div class="field">' +
                    '<label class="field-label">单词书名称</label>' +
                    '<input class="field-input" id="book-name" value="' + esc(book.name) + '" autocomplete="off">' +
                  '</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                {
                    label: '保存',
                    className: 'btn-primary',
                    onClick: (close) => {
                        const value = $('#book-name').value.trim();
                        if (!value) {
                            toast('名称不能为空');
                            return;
                        }
                        Store.renameBook(bookId, value);
                        close();
                        render();
                        toast('已重命名');
                    }
                }
            ],
            onMount: (mask) => {
                setTimeout(() => $('#book-name', mask).focus(), 60);
            }
        });
    }

    /* =========================================================
     * 封面编辑器：纯色 / 图案 / 图片
     * ========================================================= */

    function openCoverEditor(bookId) {
        const book = Store.getBook(bookId);
        if (!book) {
            return;
        }
        const draft = {
            type: book.cover.type,
            color: book.cover.color,
            pattern: book.cover.pattern || 'dots',
            image: book.cover.image || null
        };

        const swatches = Cover.COLORS.map((color) =>
            '<button type="button" class="swatch' + (draft.color === color ? ' active' : '') +
            '" data-color="' + color + '" style="background:' + color + ';"></button>'
        ).join('');

        const patternCells = Object.keys(Cover.PATTERNS).filter((key) => key !== 'plain').map((key) =>
            '<button type="button" class="pattern-cell' + (draft.pattern === key ? ' active' : '') +
            '" data-pattern="' + key + '" style="' + Cover.patternPreview(draft.color, key) + '">' +
            Cover.PATTERNS[key].label + '</button>'
        ).join('');

        openModal({
            title: '更换封面',
            body:
                '<div class="cover-preview" id="cover-preview"></div>' +
                '<div class="field">' +
                    '<div class="seg" id="cover-tab">' +
                        '<button type="button" class="seg-item" data-tab="solid">纯色</button>' +
                        '<button type="button" class="seg-item" data-tab="pattern">图案</button>' +
                        '<button type="button" class="seg-item" data-tab="image">图片</button>' +
                    '</div>' +
                '</div>' +
                '<div id="pane-solid" class="cover-pane">' +
                    '<div class="field">' +
                        '<label class="field-label">选择颜色</label>' +
                        '<div class="swatch-grid">' + swatches + '</div>' +
                    '</div>' +
                '</div>' +
                '<div id="pane-pattern" class="cover-pane">' +
                    '<div class="field">' +
                        '<label class="field-label">选择颜色</label>' +
                        '<div class="swatch-grid">' + swatches + '</div>' +
                    '</div>' +
                    '<div class="field">' +
                        '<label class="field-label">选择图案</label>' +
                        '<div class="pattern-grid">' + patternCells + '</div>' +
                    '</div>' +
                '</div>' +
                '<div id="pane-image" class="cover-pane">' +
                    '<input type="file" accept="image/*" id="cover-file" style="display:none;">' +
                    '<button class="btn btn-block btn-lg" id="btn-pick-image" style="margin-bottom:10px;">' +
                        '从相册选择图片</button>' +
                    '<button class="btn btn-block btn-lg btn-danger" id="btn-clear-image">移除图片</button>' +
                    '<div class="field-hint">图片会自动压缩（最长边 420 像素）后保存在本机，' +
                        '建议选干净、文字少的图片。</div>' +
                '</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                {
                    label: '保存',
                    className: 'btn-primary',
                    onClick: (close) => {
                        if (draft.type === 'image' && !draft.image) {
                            toast('请先选择一张图片');
                            return;
                        }
                        Store.updateCover(bookId, draft);
                        close();
                        render();
                        toast('封面已更新');
                    }
                }
            ],
            onMount: (mask) => {
                const preview = $('#cover-preview', mask);

                function refreshPreview() {
                    preview.setAttribute('style', Cover.style(draft));
                    preview.innerHTML =
                        '<div class="pv-inner">' +
                            '<div class="pv-title">' + esc(book.name) + '</div>' +
                            '<div class="pv-num">' + esc(Schedule.stats(book, Date.now()).learned) +
                                ' / ' + book.words.length + ' 已学</div>' +
                        '</div>';
                }

                function refreshTabs() {
                    $$('#cover-tab .seg-item', mask).forEach((item) => {
                        const active = item.getAttribute('data-tab') === draft.type;
                        item.classList.toggle('active', active);
                    });
                    ['solid', 'pattern', 'image'].forEach((key) => {
                        const pane = $('#pane-' + key, mask);
                        if (pane) {
                            pane.style.display = draft.type === key ? '' : 'none';
                        }
                    });
                }

                function refreshSwatches() {
                    $$('.swatch', mask).forEach((item) => {
                        item.classList.toggle('active', item.getAttribute('data-color') === draft.color);
                    });
                    $$('.pattern-cell', mask).forEach((item) => {
                        const key = item.getAttribute('data-pattern');
                        item.classList.toggle('active', key === draft.pattern);
                        item.setAttribute('style', Cover.patternPreview(draft.color, key));
                    });
                }

                $$('#cover-tab .seg-item', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        draft.type = item.getAttribute('data-tab');
                        if (draft.type === 'image' && draft.image) {
                            // 已有图片，直接预览
                        } else if (draft.type === 'image') {
                            // 没有图片时先保持当前样式，等用户选择
                        }
                        refreshTabs();
                        refreshPreview();
                    });
                });

                $$('.swatch', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        draft.color = item.getAttribute('data-color');
                        if (draft.type === 'image') {
                            draft.type = 'solid';
                        }
                        refreshSwatches();
                        refreshTabs();
                        refreshPreview();
                    });
                });

                $$('.pattern-cell', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        draft.pattern = item.getAttribute('data-pattern');
                        draft.type = 'pattern';
                        refreshSwatches();
                        refreshTabs();
                        refreshPreview();
                    });
                });

                $('#btn-pick-image', mask).addEventListener('click', () => {
                    $('#cover-file', mask).click();
                });

                $('#cover-file', mask).addEventListener('change', (event) => {
                    const file = event.target.files && event.target.files[0];
                    if (!file) {
                        return;
                    }
                    toast('正在压缩图片…');
                    Cover.compressImage(file, 420).then((dataUrl) => {
                        draft.type = 'image';
                        draft.image = dataUrl;
                        refreshTabs();
                        refreshPreview();
                        toast('已压缩并应用');
                    }).catch(() => {
                        toast('图片读取失败，换一张试试');
                    });
                });

                $('#btn-clear-image', mask).addEventListener('click', () => {
                    draft.image = null;
                    draft.type = 'solid';
                    refreshTabs();
                    refreshPreview();
                });

                refreshTabs();
                refreshSwatches();
                refreshPreview();
            }
        });
    }

    /* =========================================================
     * 视图：词书详情
     * ========================================================= */

    /** 词书里三类互斥状态的人数式配色 */
    const GROUP_STYLE = {
        unlearned: { label: '未学习', color: 'var(--chart-idle)', dot: 'g-idle' },
        learning: { label: '学习中', color: 'var(--fuzzy)', dot: 'g-learning' },
        mastered: { label: '已掌握', color: 'var(--accent)', dot: 'g-mastered' }
    };

    /**
     * 环形图（互斥状态：未学习 / 学习中 / 已掌握）
     * @param {Array} groups [{ key, value }]
     * @param {Number} total 总词数
     */
    function donutSvg(groups, total) {
        const size = 132;
        const center = size / 2;
        const radius = 52;
        const width = 15;
        const circumference = 2 * Math.PI * radius;
        let offset = 0;

        const segments = total > 0
            ? groups.map((group) => {
                const length = group.value / total * circumference;
                if (length <= 0) {
                    return '';
                }
                const style = GROUP_STYLE[group.key];
                const circle =
                    '<circle class="donut-seg" cx="' + center + '" cy="' + center + '" r="' + radius + '" ' +
                        'fill="none" stroke="' + style.color + '" stroke-width="' + width + '" ' +
                        'stroke-dasharray="' + length.toFixed(2) + ' ' + (circumference - length).toFixed(2) + '" ' +
                        'stroke-dashoffset="' + (-offset).toFixed(2) + '"></circle>';
                offset += length;
                return circle;
            }).join('')
            : '';

        return '<svg class="donut" viewBox="0 0 ' + size + ' ' + size + '" role="img" ' +
                    'aria-label="学习情况分布">' +
                    '<circle cx="' + center + '" cy="' + center + '" r="' + radius + '" fill="none" ' +
                        'stroke="var(--surface-3)" stroke-width="' + width + '"></circle>' +
                    '<g transform="rotate(-90 ' + center + ' ' + center + ')">' + segments + '</g>' +
                '</svg>';
    }

    function renderBook() {
        const book = Store.getBook(state.bookId);
        if (!book) {
            state.view = 'home';
            renderHome();
            return;
        }
        const now = Date.now();
        const stats = Schedule.stats(book, now);
        const percent = stats.total === 0 ? 0 : Math.round(stats.learned / stats.total * 100);

        // 三类互斥状态：未学习 / 学习中 / 已掌握
        const masteredCount = book.words.filter(isMastered).length;
        const learningCount = stats.learned - masteredCount;
        const masteredPercent = stats.total === 0 ? 0 : Math.round(masteredCount / stats.total * 100);
        const groups = [
            { key: 'unlearned', value: stats.unlearned },
            { key: 'learning', value: learningCount },
            { key: 'mastered', value: masteredCount }
        ];

        const reviewLabel = '开始复习 · 今日 ' + stats.dueCount;

        $('#app').innerHTML =
            '<div class="topbar">' +
                '<button class="icon-btn" id="btn-back">←</button>' +
                '<div class="topbar-title">' + esc(book.name) + '</div>' +
                '<button class="icon-btn" id="btn-book-menu">⋯</button>' +
            '</div>' +
            '<div class="page">' +
                '<div class="book-head">' +
                    '<div class="book-thumb" style="' + Cover.style(book.cover) + '"></div>' +
                    '<div class="book-head-info">' +
                        '<div class="book-head-name">' + esc(book.name) + '</div>' +
                        '<div class="book-head-sub">共 ' + stats.total + ' 个单词 · 已学 ' + stats.learned + ' 个</div>' +
                        '<div class="head-bar"><i style="width:' + percent + '%"></i></div>' +
                        '<div class="book-head-percent">学习进度 ' + percent + '%</div>' +
                    '</div>' +
                '</div>' +
                '<div class="section-title">学习情况</div>' +
                '<div class="card progress-card">' +
                    '<div class="progress-main">' +
                        '<div class="donut-wrap">' +
                            donutSvg(groups, stats.total) +
                            '<div class="donut-center">' +
                                '<div class="donut-num">' +
                                    (stats.total === 0 ? '—' : masteredPercent + '%') +
                                '</div>' +
                                '<div class="donut-label">已掌握</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="legend">' +
                            groups.map((group) => {
                                const style = GROUP_STYLE[group.key];
                                const ratio = stats.total === 0
                                    ? 0
                                    : Math.round(group.value / stats.total * 100);
                                return '<div class="legend-item">' +
                                        '<i class="dot ' + style.dot + '"></i>' +
                                        '<span class="lg-name">' + style.label + '</span>' +
                                        '<span class="lg-val">' + group.value +
                                            ' <em>' + ratio + '%</em></span>' +
                                    '</div>';
                            }).join('') +
                        '</div>' +
                    '</div>' +
                    '<div class="mini-grid">' +
                        miniCard(stats.total, '总词数', '') +
                        miniCard(stats.dueCount, '今日待复习', 'accent') +
                        miniCard(stats.overdueCount, '逾期未复习', 'warn') +
                    '</div>' +
                    '<div class="progress-note">环形图里三类状态互不重复；' +
                        '「待复习」和「逾期」是对同一批单词的另一种看法，不单独计入。</div>' +
                '</div>' +
                '<div class="action-block">' +
                    '<button class="btn btn-primary btn-lg btn-main" id="btn-start-new">开始背单词</button>' +
                    '<button class="btn btn-lg" id="btn-start-review">' + esc(reviewLabel) + '</button>' +
                    '<button class="btn btn-lg" id="btn-practice">练习测试</button>' +
                '</div>' +
                '<div class="section-title">单词</div>' +
                '<button type="button" class="card entry-card" id="btn-open-library">' +
                    '<div class="entry-main">' +
                        '<div class="entry-title">单词库</div>' +
                        '<div class="entry-desc">共 ' + stats.total + ' 个单词 · 可搜索、按状态筛选、增删改</div>' +
                    '</div>' +
                    '<div class="entry-arrow">›</div>' +
                '</button>' +
                '<button class="btn btn-primary btn-block btn-lg" id="btn-add-word">＋ 添加新单词</button>' +
            '</div>';

        $('#btn-back').addEventListener('click', goHome);
        $('#btn-book-menu').addEventListener('click', () => openBookMenu(book.id));
        $('#btn-start-new').addEventListener('click', startNewWords);
        $('#btn-start-review').addEventListener('click', startReview);
        $('#btn-practice').addEventListener('click', openPracticeDialog);
        $('#btn-add-word').addEventListener('click', () => openWordDialog(null));
        $('#btn-open-library').addEventListener('click', () => openLibrary(book.id));
    }

    function miniCard(value, label, extraClass) {
        return '<div class="mini ' + (extraClass || '') + '">' +
                    '<div class="mini-num">' + esc(value) + '</div>' +
                    '<div class="mini-label">' + esc(label) + '</div>' +
               '</div>';
    }

    /** 打开这本词书的单词库（独立页面） */
    function openLibrary(bookId) {
        state.bookId = bookId || state.bookId;
        state.search = '';
        state.libFilter = 'all';
        state.libSort = 'order';
        state.view = 'library';
        render(true);
    }

    /* =========================================================
     * 单词库（独立页面）：搜索 + 筛选 + 排序 + 增删改
     * ========================================================= */

    /** 筛选条件：与详情页环形图的三类互斥状态对应，另外多了「待复习 / 逾期」两个视图 */
    const LIB_FILTERS = [
        { key: 'all', label: '全部' },
        { key: 'new', label: '未学习' },
        { key: 'learning', label: '学习中' },
        { key: 'due', label: '待复习' },
        { key: 'overdue', label: '逾期' },
        { key: 'mastered', label: '已掌握' }
    ];

    const LIB_SORTS = [
        { key: 'order', label: '添加顺序' },
        { key: 'alpha', label: '字母 A→Z' },
        { key: 'recent', label: '最近学习' },
        { key: 'stage', label: '复习阶段' }
    ];

    /** 单个单词是否命中某个筛选条件 */
    function matchLibFilter(word, key, now) {
        switch (key) {
            case 'new':
                return word.stage < 0;
            case 'learning':
                return word.stage >= 0 && !isMastered(word);
            case 'due':
                return isDueWord(word, now);
            case 'overdue':
                return isOverdueWord(word, now);
            case 'mastered':
                return isMastered(word);
            default:
                return true;
        }
    }

    /** 排序；order 保持原添加顺序，不做重排 */
    function sortLibraryWords(list, key) {
        const arr = list.slice();
        if (key === 'alpha') {
            arr.sort((a, b) => a.english.localeCompare(b.english, 'en'));
        } else if (key === 'recent') {
            arr.sort((a, b) =>
                (b.lastReviewAt || b.learnedAt || 0) - (a.lastReviewAt || a.learnedAt || 0));
        } else if (key === 'stage') {
            arr.sort((a, b) => (a.stage - b.stage) || a.english.localeCompare(b.english, 'en'));
        }
        return arr;
    }

    function renderLibrary() {
        const book = Store.getBook(state.bookId);
        if (!book) {
            state.view = 'home';
            renderHome();
            return;
        }
        const now = Date.now();
        const filter = state.libFilter || 'all';
        const sort = state.libSort || 'order';

        $('#app').innerHTML =
            '<div class="topbar">' +
                '<button class="icon-btn" id="btn-back">←</button>' +
                '<div class="topbar-title">单词库</div>' +
                '<button class="icon-btn" id="btn-add-word-top" title="添加新单词">＋</button>' +
            '</div>' +
            '<div class="page">' +
                '<div class="library-head">' +
                    '<div class="library-book">《' + esc(book.name) + '》</div>' +
                    '<div class="library-count" id="library-count"></div>' +
                '</div>' +
                '<input class="search-box" id="search-box" ' +
                    'placeholder="搜索英文、释义、备注或用法" autocomplete="off" ' +
                    'value="' + esc(state.search) + '">' +
                '<div class="chip-row" id="filter-chips">' +
                    LIB_FILTERS.map((item) =>
                        '<button type="button" class="chip' + (filter === item.key ? ' active' : '') +
                            '" data-filter="' + item.key + '">' + esc(item.label) +
                            '<span class="chip-num" data-count="' + item.key + '"></span>' +
                        '</button>'
                    ).join('') +
                '</div>' +
                '<div class="chip-row chip-row-sub" id="sort-chips">' +
                    '<span class="chip-label">排序</span>' +
                    LIB_SORTS.map((item) =>
                        '<button type="button" class="chip chip-sm' + (sort === item.key ? ' active' : '') +
                            '" data-sort="' + item.key + '">' + esc(item.label) + '</button>'
                    ).join('') +
                '</div>' +
                '<div id="word-region"></div>' +
                '<button class="btn btn-primary btn-block btn-lg" id="btn-add-word">＋ 添加新单词</button>' +
            '</div>';

        $('#btn-back').addEventListener('click', () => openBook(book.id));
        $('#btn-add-word-top').addEventListener('click', () => openWordDialog(null));
        $('#btn-add-word').addEventListener('click', () => openWordDialog(null));

        const search = $('#search-box');
        search.addEventListener('input', () => {
            state.search = search.value;
            renderLibraryList(book, Date.now());
        });

        $$('#filter-chips .chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                state.libFilter = chip.getAttribute('data-filter');
                $$('#filter-chips .chip').forEach((other) => {
                    other.classList.toggle('active', other === chip);
                });
                renderLibraryList(book, Date.now());
            });
        });

        $$('#sort-chips .chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                state.libSort = chip.getAttribute('data-sort');
                $$('#sort-chips .chip').forEach((other) => {
                    other.classList.toggle('active', other === chip);
                });
                renderLibraryList(book, Date.now());
            });
        });

        renderLibraryList(book, now);
    }

    /** 渲染单词库列表：只重画列表区域，避免搜索框失焦 */
    function renderLibraryList(book, now) {
        const keyword = state.search.trim().toLowerCase();
        const filter = state.libFilter || 'all';
        const sort = state.libSort || 'order';

        // 先按关键词过滤，再统计各筛选项的数量
        const searched = book.words.filter((word) => {
            if (!keyword) {
                return true;
            }
            const hay = (word.english + ' ' + word.meanings.join(' ') + ' ' +
                (word.note || '') + ' ' + (word.usage || '')).toLowerCase();
            return hay.indexOf(keyword) >= 0;
        });

        LIB_FILTERS.forEach((item) => {
            const count = searched.filter((word) => matchLibFilter(word, item.key, now)).length;
            $$('[data-count="' + item.key + '"]').forEach((node) => {
                node.textContent = count;
            });
        });

        const list = sortLibraryWords(
            searched.filter((word) => matchLibFilter(word, filter, now)),
            sort
        );

        const countNode = document.getElementById('library-count');
        if (countNode) {
            const filterText = filter === 'all' ? '' : ' · ' + (LIB_FILTERS.filter(
                (item) => item.key === filter
            )[0] || {}).label;
            countNode.textContent = '共 ' + book.words.length + ' 个单词' +
                filterText + ' · 当前显示 ' + list.length + ' 个';
        }

        const region = document.getElementById('word-region');
        if (!region) {
            return;
        }

        if (list.length === 0) {
            const empty = libraryEmptyHtml(book.words.length === 0, keyword, filter);
            region.innerHTML =
                '<div class="empty">' +
                    '<div class="empty-title">' + esc(empty.title) + '</div>' +
                    '<div>' + esc(empty.desc) + '</div>' +
                '</div>';
        } else {
            region.innerHTML = '<div class="word-list">' +
                list.map((word) => wordItemHtml(word, now)).join('') +
                '</div>';
            bindWordItems();
        }
    }

    /** 单词库四种空状态，文案统一风格，不伪造数据 */
    function libraryEmptyHtml(noWords, keyword, filter) {
        if (noWords) {
            return { title: '这本单词书还没有单词', desc: '点下面的「添加新单词」放进第一个单词。' };
        }
        if (keyword) {
            return { title: '没有匹配的单词', desc: '换个关键词，或者清空搜索框看看全部单词。' };
        }
        if (filter === 'due') {
            return { title: '今天没有需要复习的单词', desc: '按遗忘曲线，今天到期的都复习完了，明天再来看看。' };
        }
        if (filter === 'overdue') {
            return { title: '没有逾期的单词', desc: '目前没有落下的复习，保持住就行。' };
        }
        if (filter === 'new') {
            return { title: '没有未学习的单词', desc: '这本词书里的单词都已经开始学了。' };
        }
        if (filter === 'learning') {
            return { title: '没有正在学习的单词', desc: '当前的单词要么还没开始学，要么已经掌握了。' };
        }
        if (filter === 'mastered') {
            return { title: '还没有掌握的单词', desc: '复习到第 8 阶段会自动标记为已掌握。' };
        }
        return { title: '这里还没有单词', desc: '换个筛选条件，或者添加新单词。' };
    }

    function wordItemHtml(word, now) {
        // 学习状态：未学习 / 学习中 / 已掌握
        const status = Schedule.statusText(word);
        let badgeClass = '';
        if (word.stage < 0) {
            badgeClass = '';
        } else if (isMastered(word)) {
            badgeClass = ' mastered';
        } else {
            badgeClass = ' stage';
        }

        // 第二行右侧的补充信息：到期情况优先，其次是下次复习时间，最后是阶段
        let extra = '';
        let extraClass = 'word-due';
        if (word.stage < 0) {
            extra = '还没开始学';
        } else if (isOverdueWord(word, now)) {
            extra = '逾期 ' + Schedule.overdueDays(word, now) + ' 天';
            extraClass = 'word-due is-overdue';
        } else if (isDueWord(word, now)) {
            extra = '今天到期';
            extraClass = 'word-due is-due';
        } else if (word.nextReview !== null) {
            extra = Utils.formatDate(word.nextReview) + ' 复习';
        } else {
            extra = Schedule.stageText(word.stage);
        }

        return '' +
            '<button class="word-item" data-word="' + word.id + '">' +
                '<div class="word-main">' +
                    '<div class="word-en">' + esc(word.english) + '</div>' +
                    '<div class="word-mean">' + esc(word.meanings.join('；')) + '</div>' +
                '</div>' +
                '<div class="word-meta">' +
                    '<span class="badge' + badgeClass + '">' + esc(status) + '</span>' +
                    '<span class="word-due">' + word.meanings.length + ' 条释义</span>' +
                    '<span class="' + extraClass + '">' + esc(extra) + '</span>' +
                '</div>' +
            '</button>';
    }

    function bindWordItems() {
        $$('.word-item').forEach((item) => {
            item.addEventListener('click', () => {
                openWordDialog(item.getAttribute('data-word'));
            });
        });
    }

    function goHome() {
        state.view = 'home';
        state.bookId = null;
        render(true);
    }

    /* =========================================================
     * 单词新增 / 编辑
     * ========================================================= */

    function openWordDialog(wordId) {
        const book = Store.getBook(state.bookId);
        if (!book) {
            return;
        }
        const editing = !!wordId;
        const word = editing ? book.words.find((item) => item.id === wordId) : null;
        if (editing && !word) {
            return;
        }

        const statusValue = word ? word.status : 'new';
        const statusSeg = editing
            ? '<div class="field">' +
                '<label class="field-label">掌握状态</label>' +
                '<div class="seg">' +
                    segItem('new', '未学习', statusValue) +
                    segItem('learning', '学习中', statusValue) +
                    segItem('mastered', '已掌握', statusValue) +
                '</div>' +
                '<div class="field-hint">选择「未学习」会清空该单词的复习进度，重新回到新词队列。</div>' +
              '</div>'
            : '';

        const records = word
            ? word.history.slice().reverse().slice(0, 10).map((record) => {
                const modeText = record.mode === 'new' ? '新学' : (record.mode === 'practice' ? '练习' : '复习');
                return '<div class="record-item">' +
                        '<span>' + modeText + ' · ' + esc(Schedule.actionText(record.action)) +
                        ' · ' + esc(Schedule.stageText(record.stageAfter)) + '</span>' +
                        '<span class="record-time">' + Utils.formatDateTime(record.at) + '</span>' +
                       '</div>';
            }).join('')
            : '';

        const recordBlock = editing
            ? '<div class="field">' +
                '<label class="field-label">复习记录（最近 ' +
                    Math.min(word.history.length, 10) + ' 条 / 共 ' + word.history.length + ' 次）</label>' +
                '<div class="record-list">' +
                    (records || '<div class="record-item"><span class="record-time">还没有复习记录</span></div>') +
                '</div>' +
              '</div>'
            : '';

        openModal({
            title: editing ? '编辑单词' : '添加新单词',
            body:
                '<div class="field">' +
                    '<label class="field-label">英文</label>' +
                    '<input class="field-input" id="word-en" placeholder="例如：abandon" autocomplete="off" ' +
                        'value="' + esc(word ? word.english : '') + '">' +
                    '<div class="field-error" id="word-error"></div>' +
                '</div>' +
                '<div class="field">' +
                    '<label class="field-label">汉语释义（一行一条）</label>' +
                    '<textarea class="field-textarea" id="word-meanings" ' +
                        'placeholder="放弃&#10;抛弃&#10;离弃">' + esc(word ? word.meanings.join('\n') : '') + '</textarea>' +
                    '<div class="field-hint">每行一条释义，行内用「；」分隔也可以。系统不会判断对错，仅供查看。</div>' +
                '</div>' +
                '<div class="field">' +
                    '<label class="field-label">备注（可留空）</label>' +
                    '<textarea class="field-textarea" id="word-note" style="min-height:72px;" ' +
                        'placeholder="自己写的记忆方法、例句等">' + esc(word ? word.note : '') + '</textarea>' +
                    '<div class="field-hint">备注会和英文一起显示，不需要点「显示答案」。</div>' +
                '</div>' +
                '<div class="field">' +
                    '<label class="field-label">用法 / 短语（可留空，支持多行）</label>' +
                    '<textarea class="field-textarea" id="word-usage" style="min-height:88px;" ' +
                        'placeholder="abandon oneself to 沉溺于&#10;with abandon 放纵地&#10;an abandoned car 一辆被遗弃的车">' +
                        esc(word ? (word.usage || '') : '') + '</textarea>' +
                    '<div class="field-hint">点「显示答案」后显示在汉语释义下方；不填就留空，' +
                        '老单词没有这一项也不会报错。</div>' +
                '</div>' +
                statusSeg +
                recordBlock,
            actions: (editing
                ? [{
                    label: '删除',
                    className: 'btn-danger',
                    onClick: (close) => {
                        close();
                        confirmDialog('删除单词', '确定删除「' + word.english + '」吗？', () => {
                            Store.deleteWord(book.id, word.id);
                            toast('已删除');
                            render();
                        });
                    }
                }]
                : []
            ).concat([
                { label: '取消', onClick: (close) => close() },
                {
                    label: '保存',
                    className: 'btn-primary',
                    onClick: (close) => {
                        const english = $('#word-en').value.trim();
                        const meanings = $('#word-meanings').value
                            .split(/[\n；;]+/)
                            .map((item) => item.trim())
                            .filter((item) => item.length > 0);
                        const note = $('#word-note').value.trim();
                        const usage = $('#word-usage').value.trim();

                        if (!english) {
                            showWordError('请输入英文');
                            return;
                        }
                        if (meanings.length === 0) {
                            showWordError('请至少填写一条汉语释义');
                            return;
                        }

                        const duplicate = Store.findDuplicate(book.id, english, editing ? word.id : null);
                        if (duplicate) {
                            showWordError('这本单词书里已经有「' + duplicate.english + '」了，请换个单词或修改原有词条');
                            return;
                        }

                        const payload = {
                            english: english,
                            meanings: meanings,
                            note: note,
                            usage: usage,
                            status: currentStatus()
                        };

                        if (editing) {
                            Store.updateWord(book.id, word.id, payload);
                            toast('已保存');
                        } else {
                            Store.addWord(book.id, payload);
                            toast('已添加，排在第 ' + book.words.length + ' 个');
                        }
                        close();
                        render();
                    }
                }
            ]),
            onMount: (mask) => {
                $$('.seg-item', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        $$('.seg-item', mask).forEach((other) => other.classList.remove('active'));
                        item.classList.add('active');
                    });
                });
                setTimeout(() => $('#word-en', mask).focus(), 60);
            }
        });

        function currentStatus() {
            const active = $('.seg-item.active');
            return active ? active.getAttribute('data-value') : 'new';
        }

        function showWordError(message) {
            const node = $('#word-error');
            node.textContent = message;
            node.classList.add('show');
            toast(message);
        }
    }

    function segItem(value, label, current) {
        return '<button type="button" class="seg-item' + (current === value ? ' active' : '') +
            '" data-value="' + value + '">' + esc(label) + '</button>';
    }

    /* =========================================================
     * 背单词 / 复习 / 练习
     * ========================================================= */

    /**
     * 首页「开始今日学习」：先复习到期单词，数量不够再用新词补足到每日目标
     * 队列为空时不假装有任务，给出温和提示
     */
    function startToday() {
        const book = pickTodayBook();
        if (!book) {
            promptCreateBook();
            return;
        }

        const now = Date.now();
        const stats = Schedule.stats(book, now);
        const goal = Store.getSettings().dailyGoal || 20;
        const doneToday = stats.todayNew + stats.todayReviewed;
        const remain = Math.max(0, goal - doneToday);

        // 到期的先来，超出剩余目标的部分留到明天（不会消失，只是今天先不练）
        let queue = stats.due.slice(0, remain);
        if (remain > queue.length) {
            queue = queue.concat(stats.newWords.slice(0, remain - queue.length));
        }

        if (queue.length === 0) {
            openModal({
                title: '今天的学习任务已经完成',
                body: '<div style="padding:6px 0 12px;line-height:1.7;">' +
                        '今天已经完成 ' + doneToday + ' 个（目标 ' + goal + ' 个）。' +
                        (stats.unlearned > 0
                            ? '想继续的话，可以到单词书里点「开始背单词」再多背几个新词。'
                            : '明天会有自动安排好的复习，到时候再来。') +
                      '</div>',
                actions: [
                    { label: '知道了', className: 'btn-primary', onClick: (close) => close() },
                    {
                        label: '打开单词书',
                        onClick: (close) => {
                            close();
                            openBook(book.id);
                        }
                    }
                ]
            });
            return;
        }

        state.bookId = book.id;
        state.focusBookId = book.id;
        enterStudy('today', queue);
    }

    function startNewWords() {
        const book = Store.getBook(state.bookId);
        const queue = Schedule.newWords(book);
        if (queue.length === 0) {
            openModal({
                title: '新词已经背完',
                body: '<div style="padding:6px 0 12px;line-height:1.7;">这本单词书里没有未学习的新词了。' +
                      '可以去「开始复习」巩固，或继续添加新单词。</div>',
                actions: [{ label: '知道了', className: 'btn-primary', onClick: (close) => close() }]
            });
            return;
        }
        enterStudy('new', queue);
    }

    function startReview() {
        const book = Store.getBook(state.bookId);
        const queue = Schedule.dueWords(book, Date.now());
        if (queue.length === 0) {
            openModal({
                title: '今天没有要复习的单词',
                body: '<div style="padding:6px 0 12px;line-height:1.7;">按遗忘曲线，今天到期的单词已经全部复习完。' +
                      '明天再来看看，或者去「练习」里额外练一练。</div>',
                actions: [{ label: '知道了', className: 'btn-primary', onClick: (close) => close() }]
            });
            return;
        }
        enterStudy('review', queue);
    }

    function enterStudy(mode, words) {
        state.view = 'study';
        state.study = {
            mode: mode,
            bookId: state.bookId,
            queue: words.map((word) => word.id),
            index: 0,
            showAnswer: false,
            finished: false
        };
        state.lastAction = null;
        render(true);
    }

    /* =========================================================
     * 朗读（Web Speech API，纯本地合成）
     * ========================================================= */

    // 喇叭图标：用内联 SVG 而非 emoji，保证深浅色、各平台观感一致
    const SPEAK_ICON =
        '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
            '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
            '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
        '</svg>';

    /** 英文单词旁边的喇叭按钮；浏览器不支持朗读时不渲染 */
    function speakButtonHtml() {
        if (!global.TTS.supported()) {
            return '';
        }
        return '<button type="button" class="speak-btn" id="btn-speak" ' +
            'aria-label="朗读这个单词">' + SPEAK_ICON + '</button>';
    }

    function bindSpeakButton(text) {
        const btn = $('#btn-speak');
        if (!btn) {
            return;
        }
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            speakWord(text);
        });
    }

    /** 手动点击喇叭 */
    function speakWord(text) {
        if (!global.TTS.speak(text)) {
            toast('朗读失败，检查一下系统里有没有安装英语语音包');
        }
    }

    /** 自动朗读：切到下一个单词时读一遍，可在设置里关掉 */
    function autoSpeakWord(text) {
        if (!Store.getSettings().autoRead) {
            return;
        }
        global.TTS.speak(text);
    }

    function renderStudy() {
        $('#app').innerHTML =
            '<div class="study">' +
                '<div class="study-top">' +
                    '<button class="icon-btn" id="btn-study-exit">←</button>' +
                    '<div class="study-progress" id="study-progress"></div>' +
                    '<div style="width:40px;"></div>' +
                '</div>' +
                '<div class="study-body" id="study-body"></div>' +
                '<div class="study-foot">' +
                    '<div class="study-actions" id="study-actions">' +
                        '<button class="act-btn act-know" data-action="know">认识</button>' +
                        '<button class="act-btn act-fuzzy" data-action="fuzzy">模糊</button>' +
                        '<button class="act-btn act-unknown" data-action="unknown">不认识</button>' +
                    '</div>' +
                    '<div class="undo-row">' +
                        '<button class="undo-btn" id="btn-undo" disabled>撤销刚才的操作</button>' +
                    '</div>' +
                    '<div class="study-tip" id="study-tip"></div>' +
                '</div>' +
            '</div>';

        $('#btn-study-exit').addEventListener('click', exitStudy);
        $('#btn-undo').addEventListener('click', undoLastAction);
        $$('.act-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                handleAnswer(btn.getAttribute('data-action'));
            });
        });
        updateStudyCard();
    }

    function currentWord() {
        const book = Store.getBook(state.study.bookId);
        const wordId = state.study.queue[state.study.index];
        return book.words.find((item) => item.id === wordId) || null;
    }

    /** 更新当前单词（保留输入框焦点体验） */
    function updateStudyCard() {
        const study = state.study;
        const book = Store.getBook(study.bookId);
        const now = Date.now();
        const progress = $('#study-progress');
        const body = $('#study-body');
        const actions = $('#study-actions');
        const tip = $('#study-tip');
        const undo = $('#btn-undo');

        if (study.finished || study.index >= study.queue.length) {
            study.finished = true;
            const doneCount = study.queue.length;
            const modeText = study.mode === 'new' ? '新词'
                : (study.mode === 'review' ? '复习'
                : (study.mode === 'today' ? '今日' : '练习'));
            progress.textContent = '本次完成 ' + doneCount + ' 个';
            const backText = study.mode === 'today' ? '返回首页' : '返回单词书';
            body.innerHTML =
                '<div class="empty">' +
                    '<div class="empty-title">这一轮结束了</div>' +
                    '<div>共完成 ' + doneCount + ' 个' + modeText + '单词。</div>' +
                '</div>' +
                '<button class="btn btn-primary btn-block btn-lg" id="btn-finish-back">' +
                    backText + '</button>';
            actions.style.display = 'none';
            tip.textContent = '';
            $('#btn-finish-back').addEventListener('click', exitStudy);
        } else {
            const word = currentWord();
            const orderInBook = book.words.indexOf(word) + 1;
            const remain = study.queue.length - study.index;

            if (study.mode === 'new') {
                progress.textContent = '第 ' + orderInBook + ' 个 · 还剩 ' + remain + ' 个没背';
            } else if (study.mode === 'today') {
                progress.textContent = '今日 ' + (study.index + 1) + ' / ' + study.queue.length +
                    ' · 还剩 ' + remain + ' 个';
            } else {
                progress.textContent = (study.mode === 'review' ? '复习 ' : '练习 ') +
                    (study.index + 1) + ' / ' + study.queue.length + ' · 还剩 ' + remain + ' 个';
            }

            body.innerHTML =
                '<div class="study-word-row">' +
                    '<div class="study-word">' + esc(word.english) + '</div>' +
                    speakButtonHtml() +
                '</div>' +
                (word.note
                    ? '<div class="study-note"><div class="study-note-title">备注</div>' +
                      esc(word.note) + '</div>'
                    : '') +
                '<div class="study-input-wrap">' +
                    '<input class="study-answer-input" id="answer-input" ' +
                        'placeholder="输入你想到的汉语释义（不判断对错）" autocomplete="off">' +
                    '<button class="btn-show" id="btn-show-answer">显示答案</button>' +
                    '<div id="answer-area"></div>' +
                    '<div class="answer-extra" id="answer-extra"></div>' +
                '</div>';

            $('#btn-show-answer').addEventListener('click', showAnswer);
            bindSpeakButton(word.english);

            // 进入下一个单词自动读一遍（开关在设置里，默认开启）
            autoSpeakWord(word.english);

            $('#answer-input').addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    showAnswer();
                }
            });

            // 同步聚焦：iOS 只会在用户手势的执行流里弹出键盘
            const answerInput = $('#answer-input');
            if (answerInput) {
                answerInput.focus();
            }

            actions.style.display = '';
            if (study.mode === 'practice') {
                tip.textContent = '练习模式：只做记录，不改变复习计划';
            } else if (study.mode === 'new') {
                tip.textContent = '没点按钮就退出，这个单词下次还会出现';
            } else if (study.mode === 'today') {
                tip.textContent = '今日任务：到期的单词在前，后面接新词';
            } else {
                tip.textContent = '没复习完的单词会自动顺延到明天';
            }
        }

        if (state.lastAction) {
            undo.disabled = false;
            undo.textContent = '撤销刚才的操作：' + state.lastAction.label;
        } else {
            undo.disabled = true;
            undo.textContent = '撤销刚才的操作';
        }
    }

    function showAnswer() {
        const word = currentWord();
        const now = Date.now();
        state.study.showAnswer = true;
        const items = word.meanings.map((meaning) =>
            '<div class="answer-item">' + esc(meaning) + '</div>'
        ).join('');

        // 用法 / 短语是后加的可选字段，老单词没有这项就整块不显示
        const usage = (word.usage || '').trim();
        const usageBlock = usage
            ? '<div class="answer-usage">' +
                  '<div class="answer-usage-title">用法 / 短语</div>' +
                  '<div class="answer-usage-text">' + esc(usage) + '</div>' +
              '</div>'
            : '';

        $('#answer-area').innerHTML =
            '<div class="answer-box">' +
                '<div class="answer-count">共 ' + word.meanings.length + ' 条释义</div>' +
                items +
            '</div>' +
            usageBlock;
        $('#answer-extra').textContent = word.stage < 0
            ? '第一次学习'
            : '当前 ' + Schedule.stageText(word.stage) +
              (Schedule.overdueDays(word, now) > 0 ? ' · 已逾期 ' + Schedule.overdueDays(word, now) + ' 天' : '');
        $('#btn-show-answer').classList.add('hidden');
    }

    function handleAnswer(action) {
        const study = state.study;
        const book = Store.getBook(study.bookId);
        const word = currentWord();
        if (!word) {
            return;
        }

        const result = Schedule.applyAnswer(word, action, study.mode);
        if (study.mode !== 'practice' && result.todayKey) {
            const field = result.isNew ? 'newLearned' : 'reviewed';
            Store.bumpDaily(book.id, result.todayKey, field, 1);
        }
        Store.save();

        state.lastAction = {
            bookId: book.id,
            wordId: word.id,
            mode: study.mode,
            before: result.before,
            queueIndex: study.index,
            dailyKey: result.todayKey,
            dailyField: result.isNew ? 'newLearned' : 'reviewed',
            label: word.english + ' · ' + Schedule.actionText(action)
        };

        study.index += 1;
        study.showAnswer = false;
        updateStudyCard();
    }

    function undoLastAction() {
        const action = state.lastAction;
        if (!action) {
            return;
        }
        const book = Store.getBook(action.bookId);
        const word = book.words.find((item) => item.id === action.wordId);
        if (!word) {
            state.lastAction = null;
            updateStudyCard();
            return;
        }

        Schedule.revertAnswer(word, action.before);
        if (action.mode !== 'practice' && action.dailyKey) {
            Store.bumpDaily(book.id, action.dailyKey, action.dailyField, -1);
        }
        Store.save();

        state.lastAction = null;
        state.study.index = action.queueIndex;
        state.study.showAnswer = false;
        state.study.finished = false;
        updateStudyCard();
        toast('已撤销：' + action.label);
    }

    function exitStudy() {
        global.TTS.cancel();   // 离开背单词页就停下朗读，别让它读到详情页去
        const fromToday = state.study && state.study.mode === 'today';
        if (fromToday) {
            // 从首页的「今日学习」进来，退出就回到首页
            state.view = 'home';
            state.bookId = null;
        } else {
            state.view = 'book';
        }
        state.study = null;
        state.lastAction = null;
        render(true);
    }

    /* =========================================================
     * 练习
     * ========================================================= */

    function openPracticeDialog() {
        const book = Store.getBook(state.bookId);
        const pool = Schedule.reviewableWords(book);
        if (pool.length === 0) {
            openModal({
                title: '还没有可练习的单词',
                body: '<div style="padding:6px 0 12px;line-height:1.7;">练习的单词来自「已经进入复习状态」的单词，' +
                      '也就是至少学过一次的单词。先去背几个新词吧。</div>',
                actions: [{ label: '知道了', className: 'btn-primary', onClick: (close) => close() }]
            });
            return;
        }

        const defaultCount = Math.min(10, pool.length);
        openModal({
            title: '练习',
            body:
                '<div class="field">' +
                    '<label class="field-label">选择方式</label>' +
                    '<div class="seg">' +
                        '<button type="button" class="seg-item active" data-value="random">随机抽取</button>' +
                        '<button type="button" class="seg-item" data-value="weak">不熟优先</button>' +
                    '</div>' +
                    '<div class="field-hint">「不熟优先」按复习阶段从低到高挑选，阶段越低越优先。</div>' +
                '</div>' +
                '<div class="field">' +
                    '<label class="field-label">数量（最多 ' + pool.length + ' 个）</label>' +
                    '<input class="field-input" id="practice-count" type="number" min="1" ' +
                        'max="' + pool.length + '" value="' + defaultCount + '">' +
                '</div>' +
                '<div class="field-hint">练习时点「认识 / 模糊 / 不认识」只做记录，' +
                    '不会改变原来的复习计划，也不更新阶段和下次复习日期。</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                {
                    label: '开始练习',
                    className: 'btn-primary',
                    onClick: (close) => {
                        const modeValue = $('.seg-item.active').getAttribute('data-value');
                        let count = parseInt($('#practice-count').value, 10);
                        if (!count || count < 1) {
                            count = 1;
                        }
                        count = Math.min(count, pool.length);
                        const selected = modeValue === 'weak'
                            ? pickWeak(pool, count)
                            : pickRandom(pool, count);
                        close();
                        enterStudy('practice', selected);
                    }
                }
            ],
            onMount: (mask) => {
                $$('.seg-item', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        $$('.seg-item', mask).forEach((other) => other.classList.remove('active'));
                        item.classList.add('active');
                    });
                });
            }
        });
    }

    function pickRandom(pool, count) {
        const copy = pool.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const temp = copy[i];
            copy[i] = copy[j];
            copy[j] = temp;
        }
        return copy.slice(0, count);
    }

    function pickWeak(pool, count) {
        return pool.slice().sort((a, b) => {
            if (a.stage !== b.stage) {
                return a.stage - b.stage;
            }
            return (a.lastReviewAt || 0) - (b.lastReviewAt || 0);
        }).slice(0, count);
    }

    /* =========================================================
     * 设置
     * ========================================================= */

    function openSettings() {
        const settings = Store.getSettings();
        const ttsSupported = global.TTS.supported();
        if (ttsSupported) {
            global.TTS.apply(settings);
        }
        const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        const standalone = global.navigator.standalone === true ||
            (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);

        let installTip;
        if (standalone) {
            installTip = '已经添加到主屏幕了，可以像 App 一样离线使用。';
        } else if (isIOS) {
            installTip = '在 Safari 里点底部「分享」按钮，选择「添加到主屏幕」，之后就能全屏离线使用。';
        } else {
            installTip = '用 Chrome 打开时，点右上角菜单里的「添加到主屏幕 / 安装应用」，之后就能全屏离线使用。';
        }

        openModal({
            title: '设置',
            body:
                '<div class="field">' +
                    '<label class="field-label">外观</label>' +
                    '<div class="seg" id="theme-seg">' +
                        segItem('system', '跟随系统', settings.theme) +
                        segItem('light', '浅色', settings.theme) +
                        segItem('dark', '深色', settings.theme) +
                    '</div>' +
                '</div>' +
                '<div class="setting-row">' +
                    '<div class="setting-label">字体大小</div>' +
                    '<input class="slider" id="font-slider" type="range" min="0.85" max="1.5" step="0.05" ' +
                        'value="' + settings.fontScale + '">' +
                    '<div class="setting-desc" id="font-value">当前：' +
                        Math.round(settings.fontScale * 100) + '%</div>' +
                    '<div class="font-preview">' +
                        '<div style="font-size:1.6rem;font-weight:700;">abandon</div>' +
                        '<div style="margin-top:4px;">放弃；抛弃；离弃</div>' +
                    '</div>' +
                '</div>' +
                '<div class="setting-row">' +
                    '<div class="setting-label">每日目标</div>' +
                    '<div class="seg" id="goal-seg">' +
                        [10, 20, 30, 50].map((item) =>
                            segItem(String(item), item + ' 个', String(settings.dailyGoal || 20))
                        ).join('') +
                    '</div>' +
                    '<div class="setting-desc">每天要完成的「新学 + 复习」总数，首页会按这个显示进度条。</div>' +
                '</div>' +
                '<div class="setting-row">' +
                    '<div class="setting-label">添加到主屏幕</div>' +
                    '<div class="setting-desc">' + esc(installTip) + '</div>' +
                    '<button class="btn btn-block" id="btn-install" style="margin-top:10px;display:none;">' +
                        '添加到主屏幕</button>' +
                '</div>' +
                (ttsSupported
                    ? '<div class="setting-row">' +
                          '<div class="setting-label">语音类型</div>' +
                          '<div class="seg" id="voice-seg">' +
                              segItem('en-US', '美音 en-US', settings.voiceLang) +
                              segItem('en-GB', '英音 en-GB', settings.voiceLang) +
                          '</div>' +
                          '<div class="setting-desc" id="voice-hint"></div>' +
                      '</div>' +
                      '<div class="setting-row">' +
                          '<div class="setting-label">自动朗读</div>' +
                          '<div class="seg" id="autoread-seg">' +
                              segItem('on', '开启', settings.autoRead ? 'on' : 'off') +
                              segItem('off', '关闭', settings.autoRead ? 'on' : 'off') +
                          '</div>' +
                          '<div class="setting-desc">开启后，每切到一个新单词就自动读一遍；' +
                              '关闭则只在点单词旁边的喇叭时朗读。</div>' +
                      '</div>' +
                      '<div class="setting-row">' +
                          '<div class="setting-label">语速</div>' +
                          '<input class="slider" id="rate-slider" type="range" ' +
                              'min="0.6" max="1.4" step="0.1" value="' + settings.speechRate + '">' +
                          '<div class="setting-desc" id="rate-value">当前：' +
                              Math.round(settings.speechRate * 100) + '%</div>' +
                          '<button class="btn btn-block" id="btn-tts-test" style="margin-top:10px;">' +
                              '试听一下</button>' +
                      '</div>'
                    : '<div class="setting-row">' +
                          '<div class="setting-label">朗读</div>' +
                          '<div class="setting-desc">当前浏览器不支持网页朗读。' +
                              '建议换用最新版 Chrome、Edge 或 Safari 打开。</div>' +
                      '</div>'
                ) +
                '<div class="setting-row">' +
                    '<div class="setting-label">数据保存</div>' +
                    '<div class="setting-desc">所有单词和复习记录都保存在这台设备的浏览器本地，' +
                        '刷新或关闭后重新打开都不会丢失。更换设备或清理浏览器数据前请先自行备份。</div>' +
                '</div>' +
                '<div class="setting-row">' +
                    '<div class="setting-label">数据备份</div>' +
                    '<div class="setting-desc">导出会把全部单词书、复习进度和设置打包成一个 JSON 文件；' +
                        '导入时可以选择「合并追加」或「覆盖恢复」。导入只做整体还原，不改变原有数据结构。</div>' +
                    '<button class="btn btn-block" id="btn-export" style="margin-top:10px;">' +
                        '导出数据（JSON 文件）</button>' +
                    '<button class="btn btn-block" id="btn-import" style="margin-top:10px;">' +
                        '导入数据（选择文件）</button>' +
                    '<div class="setting-desc" id="backup-stat" style="margin-top:8px;"></div>' +
                '</div>',
            actions: [{ label: '完成', className: 'btn-primary', onClick: (close) => close() }],
            onMount: (mask) => {
                $$('#theme-seg .seg-item', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        $$('#theme-seg .seg-item', mask).forEach((other) => other.classList.remove('active'));
                        item.classList.add('active');
                        Store.updateSettings({ theme: item.getAttribute('data-value') });
                        applyTheme();
                    });
                });
                const slider = $('#font-slider', mask);
                slider.addEventListener('input', () => {
                    const value = parseFloat(slider.value);
                    Store.updateSettings({ fontScale: value });
                    applyFontScale();
                    $('#font-value', mask).textContent = '当前：' + Math.round(value * 100) + '%';
                });

                $$('#goal-seg .seg-item', mask).forEach((item) => {
                    item.addEventListener('click', () => {
                        $$('#goal-seg .seg-item', mask).forEach((other) =>
                            other.classList.remove('active'));
                        item.classList.add('active');
                        Store.updateSettings({
                            dailyGoal: parseInt(item.getAttribute('data-value'), 10) || 20
                        });
                    });
                });

                // 备份信息：当前有多少书、多少词
                const stat = $('#backup-stat', mask);
                if (stat) {
                    const info = Store.summary(Store.data);
                    stat.textContent = '当前共 ' + info.books + ' 本单词书、' + info.words + ' 个单词。';
                }

                $('#btn-export', mask).addEventListener('click', exportData);
                $('#btn-import', mask).addEventListener('click', importData);

                // ---- 朗读设置 ----
                if (ttsSupported) {
                    /** 语音包匹配情况提示（始终读最新设置） */
                    function updateVoiceHint() {
                        const hint = $('#voice-hint', mask);
                        if (!hint) {
                            return;
                        }
                        const exact = global.TTS.exactVoices();
                        const lang = Store.getSettings().voiceLang;
                        if (exact.length === 0) {
                            hint.textContent = '系统里没有检测到 en-US / en-GB 语音包，' +
                                '会尝试用设备默认的英语发音朗读。';
                        } else if (exact.indexOf(lang) < 0) {
                            hint.textContent = '当前选择了 ' + lang + '，但本机只装了 ' +
                                exact.join(' / ') + '，会自动退化为已有的英语发音。';
                        } else {
                            hint.textContent = '已匹配到系统自带的 ' + lang + ' 语音包。';
                        }
                    }
                    updateVoiceHint();
                    // 语音包是异步返回的，稍后再刷一次提示
                    setTimeout(updateVoiceHint, 700);

                    /** 高亮某个分段控件里被选中的那一项 */
                    function pickSeg(segId, value) {
                        $$('#' + segId + ' .seg-item', mask).forEach((item) => {
                            item.classList.toggle('active', item.getAttribute('data-value') === value);
                        });
                    }

                    $$('#voice-seg .seg-item', mask).forEach((item) => {
                        item.addEventListener('click', () => {
                            const lang = item.getAttribute('data-value');
                            pickSeg('voice-seg', lang);
                            Store.updateSettings({ voiceLang: lang });
                            global.TTS.setLang(lang);
                            updateVoiceHint();
                            global.TTS.speak('pronunciation');   // 切完立刻听一下效果
                        });
                    });

                    $$('#autoread-seg .seg-item', mask).forEach((item) => {
                        item.addEventListener('click', () => {
                            const on = item.getAttribute('data-value') === 'on';
                            pickSeg('autoread-seg', on ? 'on' : 'off');
                            Store.updateSettings({ autoRead: on });
                            if (on) {
                                global.TTS.speak('auto read on');
                            }
                        });
                    });

                    const rateSlider = $('#rate-slider', mask);
                    if (rateSlider) {
                        rateSlider.addEventListener('input', () => {
                            const value = parseFloat(rateSlider.value);
                            Store.updateSettings({ speechRate: value });
                            global.TTS.setRate(value);
                            $('#rate-value', mask).textContent =
                                '当前：' + Math.round(value * 100) + '%';
                        });
                    }

                    const testBtn = $('#btn-tts-test', mask);
                    if (testBtn) {
                        testBtn.addEventListener('click', () => {
                            global.TTS.speak('pronunciation');
                        });
                    }
                }

                const installBtn = $('#btn-install', mask);
                if (deferredPrompt) {
                    installBtn.style.display = '';
                    installBtn.addEventListener('click', () => {
                        installBtn.disabled = true;
                        deferredPrompt.prompt();
                        deferredPrompt.userChoice.then((choice) => {
                            deferredPrompt = null;
                            installBtn.style.display = 'none';
                            if (choice && choice.outcome === 'accepted') {
                                toast('已添加到主屏幕');
                            }
                        });
                    });
                }
            }
        });
    }

    /* =========================================================
     * 数据导出 / 导入
     * ========================================================= */

    /** 导出：把当前全部数据下载成一个 JSON 文件 */
    function exportData() {
        const json = Store.exportJSON();
        const fileName = '单词本备份-' + Utils.formatDate(Date.now()) + '.json';
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.style.display = 'none';
        document.body.appendChild(link);

        if ('download' in link) {
            link.download = fileName;
            link.click();
            toast('已导出 ' + fileName);
        } else {
            // 老版本 iOS Safari 不支持 download 属性：直接打开，再用「共享 → 存储到文件」保存
            global.open(url, '_blank');
            toast('已打开备份内容，请用「共享 → 存储到文件」保存');
        }

        setTimeout(() => {
            URL.revokeObjectURL(url);
            link.remove();
        }, 60000);
    }

    /** 导入：选择本地备份文件 */
    function importData() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json,text/plain';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) {
                input.remove();
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                input.remove();
                const result = Store.parseBackup(String(reader.result || ''));
                if (!result.ok) {
                    toast(result.message);
                    return;
                }
                askImportMode(result.data, file.name);
            };
            reader.onerror = () => {
                input.remove();
                toast('文件读取失败，请重试');
            };
            reader.readAsText(file, 'utf-8');
        });

        input.click();
    }

    /** 导入方式二选一：合并追加 / 覆盖恢复 */
    function askImportMode(data, fileName) {
        const info = Store.summary(data);
        openModal({
            title: '导入数据',
            body:
                '<div style="padding:4px 0 10px;line-height:1.8;">' +
                    '文件：' + esc(fileName) + '<br>' +
                    '包含 <b>' + info.books + '</b> 本单词书、<b>' + info.words + '</b> 个单词。' +
                '</div>' +
                '<div class="field-hint" style="margin-top:0;">' +
                    '<b>合并追加</b>：保留现有数据，把备份里的单词书加进来（已经存在的自动跳过）。<br>' +
                    '<b>覆盖恢复</b>：清空现有数据，完全替换成备份内容。' +
                '</div>',
            actions: [
                { label: '取消', onClick: (close) => close() },
                {
                    label: '合并追加',
                    onClick: (close) => {
                        close();
                        const result = Store.mergeBooks(data);
                        state.view = 'home';
                        state.bookId = null;
                        render();
                        toast('已合并：新增 ' + result.added + ' 本，跳过 ' + result.skipped + ' 本');
                    }
                },
                {
                    label: '覆盖恢复',
                    className: 'btn-danger',
                    onClick: (close) => {
                        close();
                        confirmDialog(
                            '覆盖恢复',
                            '这会清空当前所有数据，并完全替换成备份内容，操作不可撤销。确定继续吗？',
                            () => {
                                Store.replaceAll(data);
                                applyTheme();
                                applyFontScale();
                                global.TTS.apply(Store.getSettings());
                                state.view = 'home';
                                state.bookId = null;
                                render();
                                toast('已恢复备份数据');
                            }
                        );
                    }
                }
            ]
        });
    }

    /* =========================================================
     * 启动
     * ========================================================= */

    let lastRenderedView = null;

    function render(animate) {
        if (state.view === 'book') {
            renderBook();
        } else if (state.view === 'library') {
            renderLibrary();
        } else if (state.view === 'study') {
            renderStudy();
        } else {
            renderHome();
        }
        if (animate) {
            const page = $('.page');
            if (page) {
                page.classList.add('enter');
            }
        }
        // 换页时回到顶部：上一页留下的滚动位置会把新页面顶部压在吸顶栏下面
        if (state.view !== lastRenderedView) {
            global.scrollTo(0, 0);
        }
        lastRenderedView = state.view;
    }

    function boot() {
        Store.load();
        applyTheme();
        applyFontScale();
        // 朗读模块初始化：按本地保存的语音类型与语速设置好
        global.TTS.apply(Store.getSettings());
        render();

        if (global.matchMedia) {
            const media = global.matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => {
                if (Store.getSettings().theme === 'system') {
                    applyTheme();
                }
            };
            if (media.addEventListener) {
                media.addEventListener('change', onChange);
            } else if (media.addListener) {
                media.addListener(onChange);
            }
        }

        // 重新打开网页时，按实际日期重新计算统计
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.view !== 'study') {
                render();
            }
        });

        global.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            deferredPrompt = event;
        });

        if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
            navigator.serviceWorker.register('sw.js').catch(() => {
                // 不支持时忽略，不影响正常使用
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
