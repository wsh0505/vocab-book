/* =============================================================
 * store.js —— 数据层
 * 负责：本地持久化（localStorage）、词书与单词的增删改查、每日统计
 * ============================================================= */
(function (global) {
    'use strict';

    const DATA_KEY = 'vocabApp.data.v1';
    const LOG_KEEP_DAYS = 60;   // 每日统计最多保留的天数

    /* ---------------- 通用工具 ---------------- */

    function uid(prefix) {
        return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    /** 取某个时间戳所在自然日的「日期键」，例如 2026-10-16 */
    function dateKey(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /** 取某个时间戳所在自然日的 0 点时间戳（每天 0 点算新的一天） */
    function startOfDay(ts) {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    /** 在时间戳 ts 的基础上加 days 天，返回当天 0 点 */
    function addDays(ts, days) {
        const d = new Date(startOfDay(ts));
        d.setDate(d.getDate() + days);
        return d.getTime();
    }

    /** 两个日期键之间相差的天数（b - a） */
    function diffDays(keyA, keyB) {
        const a = new Date(keyA + 'T00:00:00').getTime();
        const b = new Date(keyB + 'T00:00:00').getTime();
        return Math.round((b - a) / 86400000);
    }

    /** 把日期时间戳格式化为 2026-10-16 这样的字符串 */
    function formatDate(ts) {
        return dateKey(ts);
    }

    /** 把时间戳格式化为 10-16 09:30 */
    function formatDateTime(ts) {
        const d = new Date(ts);
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
            pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /* ---------------- 默认数据 ---------------- */

    function defaultData() {
        return {
            version: 1,
            books: [],
            settings: {
                theme: 'system',     // system | light | dark
                fontScale: 1,        // 0.9 ~ 1.5
                voiceLang: 'en-US',  // en-US 美音 | en-GB 英音
                speechRate: 1,       // 朗读语速 0.6 ~ 1.4
                autoRead: true,      // 进入下一个单词时自动朗读
                dailyGoal: 20        // 每天的学习目标（新学 + 复习，共多少个）
            }
        };
    }

    /* ---------------- 数据兼容 ---------------- */

    /**
     * 补齐缺失字段，保证老数据也能正常使用。
     * 只做「补默认值」，绝不删除或重命名字段，也不改变存储键名。
     * usage（用法/短语）是后加的可选字段：老单词没有就补成空字符串，读取时一律按空处理。
     */
    function normalizeData(data) {
        if (!data || typeof data !== 'object') {
            return null;
        }
        if (!Array.isArray(data.books)) {
            return null;
        }
        if (!data.settings || typeof data.settings !== 'object') {
            data.settings = defaultData().settings;
        }
        if (typeof data.settings.theme !== 'string') {
            data.settings.theme = 'system';
        }
        if (typeof data.settings.fontScale !== 'number') {
            data.settings.fontScale = 1;
        }
        // 朗读相关：老数据没有这三项就补默认值，不影响已有字段
        if (data.settings.voiceLang !== 'en-US' && data.settings.voiceLang !== 'en-GB') {
            data.settings.voiceLang = 'en-US';
        }
        if (typeof data.settings.speechRate !== 'number') {
            data.settings.speechRate = 1;
        }
        if (typeof data.settings.autoRead !== 'boolean') {
            data.settings.autoRead = true;
        }
        // 每日目标是后加的可选设置，老数据补默认值；数量不合理时回到 20
        if (typeof data.settings.dailyGoal !== 'number' ||
            !isFinite(data.settings.dailyGoal) || data.settings.dailyGoal < 1) {
            data.settings.dailyGoal = 20;
        }

        data.books.forEach((book, index) => {
            if (!book || typeof book !== 'object') {
                return;
            }
            if (!Array.isArray(book.words)) {
                book.words = [];
            }
            if (!book.dailyLog || typeof book.dailyLog !== 'object') {
                book.dailyLog = {};
            }
            if (!book.cover || typeof book.cover !== 'object') {
                book.cover = (global.Cover && global.Cover.defaultCover)
                    ? global.Cover.defaultCover(index)
                    : { type: 'solid', color: '#8a9a8f', pattern: 'dots', image: null };
            }
            if (typeof book.name !== 'string') {
                book.name = '未命名单词书';
            }
            if (!book.id) {
                book.id = uid('b');
            }
            if (typeof book.createdAt !== 'number') {
                book.createdAt = Date.now();
            }

            book.words.forEach((word) => {
                if (!word || typeof word !== 'object') {
                    return;
                }
                if (!Array.isArray(word.meanings)) {
                    word.meanings = [];
                }
                if (typeof word.note !== 'string') {
                    word.note = '';
                }
                // 可选字段：用法 / 短语。老数据没有这个属性时补空串，显示为空，不会报错
                if (typeof word.usage !== 'string') {
                    word.usage = '';
                }
                if (typeof word.stage !== 'number') {
                    word.stage = -1;
                }
                if (!word.status) {
                    word.status = word.stage >= 0 ? 'learning' : 'new';
                }
                if (!Array.isArray(word.history)) {
                    word.history = [];
                }
                if (!word.id) {
                    word.id = uid('w');
                }
            });
        });

        return data;
    }

    /* ---------------- 数据读写 ---------------- */

    const Store = {
        data: null,

        /** 读取本地数据；没有数据或数据损坏时使用默认数据 */
        load() {
            let parsed = null;
            try {
                const raw = localStorage.getItem(DATA_KEY);
                if (raw) {
                    parsed = JSON.parse(raw);
                }
            } catch (e) {
                parsed = null;
            }

            if (!normalizeData(parsed)) {
                parsed = defaultData();
            }

            this.data = parsed;
            return this.data;
        },

        /** 写入 localStorage */
        save() {
            try {
                localStorage.setItem(DATA_KEY, JSON.stringify(this.data));
            } catch (e) {
                global.alert('本地存储写入失败，可能是浏览器存储空间已满。');
            }
        },

        /* ---------------- 设置 ---------------- */

        getSettings() {
            return this.data.settings;
        },

        updateSettings(patch) {
            Object.assign(this.data.settings, patch);
            this.save();
        },

        /* ---------------- 词书 ---------------- */

        getBooks() {
            return this.data.books;
        },

        getBook(bookId) {
            return this.data.books.find((book) => book.id === bookId) || null;
        },

        createBook(name) {
            const book = {
                id: uid('b'),
                name: name,
                createdAt: Date.now(),
                cover: global.Cover.defaultCover(this.data.books.length),
                words: [],
                dailyLog: {}
            };
            this.data.books.push(book);
            this.save();
            return book;
        },

        /** 更换封面 */
        updateCover(bookId, cover) {
            const book = this.getBook(bookId);
            if (!book) {
                return null;
            }
            book.cover = {
                type: cover.type,
                color: cover.color,
                pattern: cover.pattern || 'dots',
                image: cover.image || null
            };
            this.save();
            return book;
        },

        renameBook(bookId, name) {
            const book = this.getBook(bookId);
            if (!book) {
                return null;
            }
            book.name = name;
            this.save();
            return book;
        },

        deleteBook(bookId) {
            const index = this.data.books.findIndex((book) => book.id === bookId);
            if (index < 0) {
                return false;
            }
            this.data.books.splice(index, 1);
            this.save();
            return true;
        },

        /* ---------------- 单词 ---------------- */

        /** 同一本词书内检查英文是否重复（可排除自身） */
        findDuplicate(bookId, english, excludeWordId) {
            const book = this.getBook(bookId);
            if (!book) {
                return null;
            }
            const target = String(english).trim().toLowerCase();
            return book.words.find((word) =>
                word.id !== excludeWordId && word.english.trim().toLowerCase() === target
            ) || null;
        },

        /** 新增单词，排在最后（按添加顺序依次往后排列） */
        addWord(bookId, payload) {
            const book = this.getBook(bookId);
            if (!book) {
                return null;
            }
            const word = {
                id: uid('w'),
                english: String(payload.english).trim(),
                meanings: payload.meanings.slice(),
                note: payload.note || '',
                usage: payload.usage || '',
                stage: -1,
                status: 'new',
                nextReview: null,
                learnedAt: null,
                lastReviewAt: null,
                reviewCount: 0,
                history: []
            };
            book.words.push(word);
            this.save();
            return word;
        },

        updateWord(bookId, wordId, payload) {
            const book = this.getBook(bookId);
            if (!book) {
                return null;
            }
            const word = book.words.find((item) => item.id === wordId);
            if (!word) {
                return null;
            }
            word.english = String(payload.english).trim();
            word.meanings = payload.meanings.slice();
            word.note = payload.note || '';
            word.usage = payload.usage || '';

            // 手动修改掌握状态：已掌握直接放到最高阶段，未学习则重置进度
            if (payload.status === 'mastered') {
                word.status = 'mastered';
                if (word.stage < 0) {
                    word.stage = Schedule.MAX_STAGE;
                }
            } else if (payload.status === 'new') {
                word.status = 'new';
                word.stage = -1;
                word.nextReview = null;
                word.learnedAt = null;
            } else {
                word.status = word.stage >= 0 ? 'learning' : 'new';
            }
            this.save();
            return word;
        },

        deleteWord(bookId, wordId) {
            const book = this.getBook(bookId);
            if (!book) {
                return false;
            }
            const index = book.words.findIndex((item) => item.id === wordId);
            if (index < 0) {
                return false;
            }
            book.words.splice(index, 1);
            this.save();
            return true;
        },

        /* ---------------- 每日统计 ---------------- */

        /** 取某本词书某天的统计，不存在则创建 */
        getDaily(bookId, key) {
            const book = this.getBook(bookId);
            if (!book) {
                return { newLearned: 0, reviewed: 0 };
            }
            if (!book.dailyLog[key]) {
                book.dailyLog[key] = { newLearned: 0, reviewed: 0 };
            }
            return book.dailyLog[key];
        },

        /** 今日统计累加（step 可为负数，用于撤销） */
        bumpDaily(bookId, key, field, step) {
            const daily = this.getDaily(bookId, key);
            daily[field] = Math.max(0, daily[field] + step);
            this.trimDaily(bookId);
            this.save();
        },

        /* ---------------- 导出 / 导入 ----------------
         * 只做整体打包与还原，不新增、不改名、不删除任何字段，
         * 因此不会影响现有数据结构和存储键名。
         */

        /** 导出当前全部数据（含所有单词书、进度、设置），返回 JSON 字符串 */
        exportJSON() {
            return JSON.stringify(this.data, null, 2);
        },

        /** 统计概览，用于导入前的提示 */
        summary(data) {
            const books = (data && Array.isArray(data.books)) ? data.books : [];
            const words = books.reduce((sum, book) =>
                sum + (Array.isArray(book.words) ? book.words.length : 0), 0);
            return { books: books.length, words: words };
        },

        /**
         * 解析备份文件内容
         * @returns {{ok: boolean, message?: string, data?: Object}}
         */
        parseBackup(text) {
            let parsed = null;
            try {
                parsed = JSON.parse(String(text));
            } catch (e) {
                return { ok: false, message: '这个文件不是有效的 JSON，可能不是备份文件' };
            }
            if (!normalizeData(parsed)) {
                return { ok: false, message: '文件里没有找到单词书数据' };
            }
            if (parsed.books.length === 0) {
                return { ok: false, message: '备份文件里没有任何单词书' };
            }
            return { ok: true, data: parsed };
        },

        /** 覆盖恢复：用备份数据整体替换当前数据 */
        replaceAll(data) {
            this.data = data;
            this.save();
            return this.data;
        },

        /**
         * 合并追加：保留当前数据，把备份里的单词书加进来
         * id 已存在的直接跳过（避免重复），其余原样追加
         */
        mergeBooks(data) {
            const known = {};
            this.data.books.forEach((book) => {
                known[book.id] = true;
            });
            let added = 0;
            let skipped = 0;
            data.books.forEach((book) => {
                if (known[book.id]) {
                    skipped += 1;
                    return;
                }
                this.data.books.push(book);
                known[book.id] = true;
                added += 1;
            });
            this.save();
            return { added: added, skipped: skipped };
        },

        /** 清理过老的每日统计，避免数据无限增长 */
        trimDaily(bookId) {
            const book = this.getBook(bookId);
            if (!book) {
                return;
            }
            const keys = Object.keys(book.dailyLog).sort();
            if (keys.length <= LOG_KEEP_DAYS) {
                return;
            }
            keys.slice(0, keys.length - LOG_KEEP_DAYS).forEach((key) => {
                delete book.dailyLog[key];
            });
        }
    };

    /* ---------------- 对外暴露 ---------------- */

    global.Utils = {
        uid: uid,
        pad2: pad2,
        dateKey: dateKey,
        startOfDay: startOfDay,
        addDays: addDays,
        diffDays: diffDays,
        formatDate: formatDate,
        formatDateTime: formatDateTime
    };

    global.Store = Store;
})(window);
