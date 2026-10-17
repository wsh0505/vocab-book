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
        lastAction: null     // 最近一次答题，用于撤销
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
     * 首页：横向书架
     * ========================================================= */

    function renderHome() {
        const books = Store.getBooks();
        const now = Date.now();

        let totalDue = 0;
        let totalOverdue = 0;
        books.forEach((book) => {
            const stats = Schedule.stats(book, now);
            totalDue += stats.dueCount;
            totalOverdue += stats.overdueCount;
        });

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

        const overview = totalDue > 0
            ? '<div class="overview">' +
                '<div class="overview-num">' + totalDue + '</div>' +
                '<div class="overview-text">今天需要复习的单词' +
                    (totalOverdue > 0 ? '<br>其中 ' + totalOverdue + ' 个已经逾期' : '') +
                '</div>' +
              '</div>'
            : '<div class="overview">' +
                '<div class="overview-text">今天没有到期的复习任务，可以背几个新词。</div>' +
              '</div>';

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
                overview +
            '</div>';

        $('#btn-settings').addEventListener('click', openSettings);
        $('#add-slot').addEventListener('click', promptCreateBook);
        setupShelf();
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

    function renderBook() {
        const book = Store.getBook(state.bookId);
        if (!book) {
            state.view = 'home';
            renderHome();
            return;
        }
        const now = Date.now();
        const stats = Schedule.stats(book, now);
        const nextNewText = stats.nextNewIndex === null ? '已全部学完' : '第 ' + stats.nextNewIndex + ' 个';
        const percent = stats.total === 0 ? 0 : Math.round(stats.learned / stats.total * 100);

        const reviewLabel = '开始复习 · 今日 ' + stats.dueCount;

        $('#app').innerHTML =
            '<div class="topbar">' +
                '<button class="icon-btn" id="btn-back">←</button>' +
                '<div class="topbar-title">' + esc(book.name) + '</div>' +
                '<button class="icon-btn" id="btn-book-menu">⋯</button>' +
            '</div>' +
            '<div class="page">' +
                '<div class="detail-cover" style="' + Cover.style(book.cover) + '">' +
                    '<div class="shade"></div>' +
                    '<div class="info">' +
                        '<div class="name">' + esc(book.name) + '</div>' +
                        '<div class="meta">已学 ' + stats.learned + ' / ' + stats.total +
                            ' · ' + percent + '%</div>' +
                    '</div>' +
                '</div>' +
                '<div class="stat-grid">' +
                    statCard(stats.total, '总单词数') +
                    statCard(stats.learned, '已学单词') +
                    statCard(stats.unlearned, '未学单词') +
                    statCard(stats.dueCount, '今日待复习', 'accent') +
                    statCard(stats.overdueCount, '逾期未复习', 'warn') +
                    statCard(stats.todayNew, '今日已背新词') +
                    statCard(stats.todayReviewed, '今日已复习') +
                    statCard(nextNewText, '下次新词从第几个开始') +
                '</div>' +
                '<div class="action-block">' +
                    '<button class="btn btn-primary btn-lg btn-main" id="btn-start-new">开始背单词</button>' +
                    '<button class="btn btn-lg" id="btn-start-review">' + esc(reviewLabel) + '</button>' +
                    '<button class="btn btn-lg" id="btn-practice">练习</button>' +
                '</div>' +
                '<div class="section-title" id="list-title">单词列表</div>' +
                '<input class="search-box" id="search-box" placeholder="搜索英文、释义或备注" ' +
                    'value="' + esc(state.search) + '">' +
                '<div style="height:12px;"></div>' +
                '<div id="word-region"></div>' +
                '<button class="btn btn-primary btn-block btn-lg" id="btn-add-word">＋ 添加新单词</button>' +
            '</div>';

        $('#btn-back').addEventListener('click', goHome);
        $('#btn-book-menu').addEventListener('click', () => openBookMenu(book.id));
        $('#btn-start-new').addEventListener('click', startNewWords);
        $('#btn-start-review').addEventListener('click', startReview);
        $('#btn-practice').addEventListener('click', openPracticeDialog);
        $('#btn-add-word').addEventListener('click', () => openWordDialog(null));

        const search = $('#search-box');
        search.addEventListener('input', () => {
            state.search = search.value;
            renderWordList(book, now);
        });

        renderWordList(book, now);
    }

    /** 渲染单词列表（含搜索过滤） */
    function renderWordList(book, now) {
        const keyword = state.search.trim().toLowerCase();
        const words = book.words.filter((word) => {
            if (!keyword) {
                return true;
            }
            const hay = (word.english + ' ' + word.meanings.join(' ') + ' ' +
                word.note + ' ' + (word.usage || '')).toLowerCase();
            return hay.indexOf(keyword) >= 0;
        });

        const title = document.getElementById('list-title');
        if (title) {
            title.textContent = '单词列表（' + words.length + '）';
        }

        const region = document.getElementById('word-region');
        if (!region) {
            return;
        }

        if (words.length === 0) {
            region.innerHTML =
                '<div class="empty">' +
                    '<div class="empty-title">' +
                        (keyword ? '没有匹配的单词' : '这本单词书还没有单词') +
                    '</div>' +
                    '<div>' + (keyword ? '换个关键词试试。' : '点击下面的按钮添加第一个单词。') + '</div>' +
                '</div>';
        } else {
            region.innerHTML = '<div class="word-list">' +
                words.map((word) => wordItemHtml(word, now)).join('') +
                '</div>';
            bindWordItems();
        }
    }

    function statCard(value, label, extraClass) {
        return '<div class="stat-card ' + (extraClass || '') + '">' +
                    '<div class="stat-value">' + esc(value) + '</div>' +
                    '<div class="stat-label">' + esc(label) + '</div>' +
               '</div>';
    }

    function wordItemHtml(word, now) {
        const overdueDays = Schedule.overdueDays(word, now);
        const isDue = word.stage >= 0 && word.nextReview !== null && overdueDays >= 0;
        let badge;
        if (word.status === 'mastered' || word.stage >= Schedule.MAX_STAGE) {
            badge = '<span class="badge mastered">已掌握</span>';
        } else if (word.stage < 0) {
            badge = '<span class="badge">未学习</span>';
        } else {
            badge = '<span class="badge stage">' + esc(Schedule.stageText(word.stage)) + '</span>';
        }
        let dueText = '';
        if (isDue && overdueDays > 0) {
            dueText = '<span class="word-due" style="color:var(--unknown);">逾期 ' + overdueDays + ' 天</span>';
        } else if (isDue) {
            dueText = '<span class="word-due">今天到期</span>';
        } else if (word.nextReview !== null) {
            dueText = '<span class="word-due">' + Utils.formatDate(word.nextReview) + ' 复习</span>';
        }
        return '' +
            '<button class="word-item" data-word="' + word.id + '">' +
                '<div class="word-main">' +
                    '<div class="word-en">' + esc(word.english) + '</div>' +
                    '<div class="word-mean">' + esc(word.meanings.join('；')) + '</div>' +
                '</div>' +
                '<div class="word-meta">' +
                    badge +
                    '<span class="word-due">共 ' + word.meanings.length + ' 条释义</span>' +
                    dueText +
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
            const modeText = study.mode === 'new' ? '新词' : (study.mode === 'review' ? '复习' : '练习');
            progress.textContent = '本次完成 ' + doneCount + ' 个';
            body.innerHTML =
                '<div class="empty">' +
                    '<div class="empty-title">这一轮结束了</div>' +
                    '<div>共完成 ' + doneCount + ' 个' + modeText + '单词。</div>' +
                '</div>' +
                '<button class="btn btn-primary btn-block btn-lg" id="btn-finish-back">返回单词书</button>';
            actions.style.display = 'none';
            tip.textContent = '';
            $('#btn-finish-back').addEventListener('click', exitStudy);
        } else {
            const word = currentWord();
            const orderInBook = book.words.indexOf(word) + 1;
            const remain = study.queue.length - study.index;

            if (study.mode === 'new') {
                progress.textContent = '第 ' + orderInBook + ' 个 · 还剩 ' + remain + ' 个没背';
            } else {
                progress.textContent = (study.mode === 'review' ? '复习 ' : '练习 ') +
                    (study.index + 1) + ' / ' + study.queue.length + ' · 还剩 ' + remain + ' 个';
            }

            body.innerHTML =
                '<div class="study-word">' + esc(word.english) + '</div>' +
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
        state.view = 'book';
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
                    '<div class="setting-label">添加到主屏幕</div>' +
                    '<div class="setting-desc">' + esc(installTip) + '</div>' +
                    '<button class="btn btn-block" id="btn-install" style="margin-top:10px;display:none;">' +
                        '添加到主屏幕</button>' +
                '</div>' +
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

                // 备份信息：当前有多少书、多少词
                const stat = $('#backup-stat', mask);
                if (stat) {
                    const info = Store.summary(Store.data);
                    stat.textContent = '当前共 ' + info.books + ' 本单词书、' + info.words + ' 个单词。';
                }

                $('#btn-export', mask).addEventListener('click', exportData);
                $('#btn-import', mask).addEventListener('click', importData);

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

    function render(animate) {
        if (state.view === 'book') {
            renderBook();
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
    }

    function boot() {
        Store.load();
        applyTheme();
        applyFontScale();
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
