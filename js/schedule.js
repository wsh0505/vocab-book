/* =============================================================
 * schedule.js —— 艾宾浩斯遗忘曲线调度
 * 阶段 0~8，对应间隔：1 / 2 / 4 / 7 / 15 / 30 / 60 / 90 / 180 天
 * 规则：
 *   认识   —— 阶段 +1（最高到 8），按新阶段的间隔安排下次复习
 *   模糊   —— 阶段不变，仍按当前阶段的间隔安排下次复习
 *   不认识 —— 阶段 -1（最低到 0），已是 0 则仍然 1 天后
 *   新词   —— 认识 → 阶段 1（2 天后）；模糊 / 不认识 → 阶段 0（1 天后）
 * 阶段只在我点击按钮时变化，天数只决定「什么时候该复习」
 * ============================================================= */
(function (global) {
    'use strict';

    const INTERVALS = [1, 2, 4, 7, 15, 30, 60, 90, 180];
    const MAX_STAGE = 8;

    const ACTION_TEXT = {
        know: '认识',
        fuzzy: '模糊',
        unknown: '不认识'
    };

    const Schedule = {
        INTERVALS: INTERVALS,
        MAX_STAGE: MAX_STAGE,

        /** 某个阶段对应的复习间隔（天） */
        intervalDays(stage) {
            const s = Math.min(Math.max(stage, 0), MAX_STAGE);
            return INTERVALS[s];
        },

        /** 根据当前阶段与按钮，计算新的阶段。-1 表示尚未学习的新词 */
        nextStage(stage, action) {
            if (stage < 0) {
                // 新词第一次学习
                return action === 'know' ? 1 : 0;
            }
            if (action === 'know') {
                return Math.min(stage + 1, MAX_STAGE);
            }
            if (action === 'fuzzy') {
                return stage;
            }
            return Math.max(stage - 1, 0);
        },

        /** 计算下次复习时间：当天 0 点 + 间隔天数 */
        nextReviewTime(stage, from) {
            return global.Utils.addDays(from, this.intervalDays(stage));
        },

        /**
         * 应用一次答题结果（会直接修改单词对象）
         * @param {Object} word    单词对象
         * @param {String} action  know | fuzzy | unknown
         * @param {String} mode    new | review | practice
         * @returns {Object} 变化详情，便于撤销
         */
        applyAnswer(word, action, mode) {
            const now = Date.now();
            const todayKey = global.Utils.dateKey(now);
            const before = {
                stage: word.stage,
                status: word.status,
                nextReview: word.nextReview,
                learnedAt: word.learnedAt,
                lastReviewAt: word.lastReviewAt,
                reviewCount: word.reviewCount,
                historyLength: word.history.length
            };

            if (mode === 'practice') {
                // 练习模式：只记录，不改变阶段与复习计划
                word.history.push({
                    at: now,
                    mode: mode,
                    action: action,
                    stage: word.stage,
                    stageAfter: word.stage
                });
                return { before: before, after: { stage: word.stage, nextReview: word.nextReview } };
            }

            const isNew = word.stage < 0;
            const nextStage = this.nextStage(word.stage, action);

            word.stage = nextStage;
            word.nextReview = this.nextReviewTime(nextStage, now);
            word.lastReviewAt = now;
            word.reviewCount = word.reviewCount + 1;
            if (isNew) {
                word.learnedAt = now;
            }
            word.status = nextStage >= MAX_STAGE ? 'mastered' : 'learning';

            word.history.push({
                at: now,
                mode: isNew ? 'new' : 'review',
                action: action,
                stage: before.stage,
                stageAfter: nextStage
            });

            return {
                before: before,
                after: { stage: nextStage, nextReview: word.nextReview },
                isNew: isNew,
                todayKey: todayKey
            };
        },

        /** 撤销一次答题结果：把单词恢复到操作前的状态 */
        revertAnswer(word, before) {
            word.stage = before.stage;
            word.status = before.status;
            word.nextReview = before.nextReview;
            word.learnedAt = before.learnedAt;
            word.lastReviewAt = before.lastReviewAt;
            word.reviewCount = before.reviewCount;
            word.history.length = before.historyLength;
        },

        /** 未学习的新词列表（保持添加顺序） */
        newWords(book) {
            return book.words.filter((word) => word.stage < 0);
        },

        /**
         * 今天需要复习的单词：到期日 <= 今天，按到期时间升序（逾期最久的排最前）
         * 没复习完的会自动顺延到明天，不会消失
         */
        dueWords(book, now) {
            const todayKey = global.Utils.dateKey(now);
            return book.words
                .filter((word) => word.stage >= 0 && word.nextReview !== null &&
                    global.Utils.dateKey(word.nextReview) <= todayKey)
                .sort((a, b) => a.nextReview - b.nextReview);
        },

        /** 已进入复习状态的单词（练习模式的候选池） */
        reviewableWords(book) {
            return book.words.filter((word) => word.stage >= 0);
        },

        /** 单词距离今天逾期了多少天（负数表示还没到期） */
        overdueDays(word, now) {
            if (word.nextReview === null) {
                return 0;
            }
            return global.Utils.diffDays(global.Utils.dateKey(word.nextReview), global.Utils.dateKey(now));
        },

        /** 掌握状态的中文描述 */
        statusText(word) {
            if (word.status === 'mastered' || word.stage >= MAX_STAGE) {
                return '已掌握';
            }
            if (word.stage < 0) {
                return '未学习';
            }
            return '学习中';
        },

        /** 阶段描述，例如「阶段 3 · 7 天后」 */
        stageText(stage) {
            if (stage < 0) {
                return '未学习';
            }
            return '阶段 ' + stage + ' · ' + this.intervalDays(stage) + ' 天后';
        },

        /** 按钮名称 */
        actionText(action) {
            return ACTION_TEXT[action] || action;
        },

        /** 词书的整体统计 */
        stats(book, now) {
            const todayKey = global.Utils.dateKey(now);
            const daily = book.dailyLog[todayKey] || { newLearned: 0, reviewed: 0 };

            const due = this.dueWords(book, now);
            const overdue = due.filter((word) => global.Utils.dateKey(word.nextReview) < todayKey);
            const newWords = this.newWords(book);
            const learned = book.words.length - newWords.length;

            const firstNewIndex = book.words.findIndex((word) => word.stage < 0);

            return {
                total: book.words.length,
                learned: learned,
                unlearned: newWords.length,
                dueCount: due.length,
                overdueCount: overdue.length,
                todayNew: daily.newLearned,
                todayReviewed: daily.reviewed,
                nextNewIndex: firstNewIndex < 0 ? null : firstNewIndex + 1,
                due: due,
                newWords: newWords
            };
        }
    };

    global.Schedule = Schedule;
})(window);
