/* =============================================================
 * tts.js —— 英文朗读（浏览器自带 Web Speech API）
 *
 * 完全本地合成：不联网、不调用任何付费 API、不加载任何音频文件。
 * 只用浏览器原生的 speechSynthesis + SpeechSynthesisUtterance。
 *
 * 对外接口：
 *   TTS.supported()        当前浏览器是否支持朗读
 *   TTS.apply(settings)    按 { voiceLang, speechRate } 应用配置
 *   TTS.setLang(lang)      设置语言，只能是 'en-US'（美音）或 'en-GB'（英音）
 *   TTS.setRate(rate)      设置语速 0.1 ~ 10，正常 speed = 1
 *   TTS.speak(text)        朗读文本，返回是否成功发起
 *   TTS.cancel()           立即停止朗读
 *   TTS.exactVoices()      本机装了哪些精确匹配的英文语音包
 * ============================================================= */
(function (global) {
    'use strict';

    /* 只允许这两种发音，和设置里的「语音类型」一一对应 */
    const LANGS = ['en-US', 'en-GB'];

    const DEFAULT_LANG = 'en-US';
    const DEFAULT_RATE = 1;

    /** 把 'en_US' 这种下划线写法统一成 'en-US' */
    function normalizeLang(lang) {
        return String(lang || '').replace(/_/g, '-').toLowerCase();
    }

    const TTS = {
        lang: DEFAULT_LANG,
        rate: DEFAULT_RATE,
        voices: [],
        voicesLoaded: false,

        /** 当前浏览器是否支持朗读（不支持时上层要把按钮藏起来） */
        supported() {
            return typeof global.speechSynthesis !== 'undefined' &&
                typeof global.SpeechSynthesisUtterance !== 'undefined';
        },

        /* ---------------- 语音包 ---------------- */

        /**
         * 刷新语音包列表。
         * 大部分浏览器（Chrome / Safari）的 getVoices() 首次调用返回空数组，
         * 要等 voiceschanged 事件才有内容，所以两边都要调。
         */
        loadVoices() {
            if (!this.supported()) {
                return [];
            }
            let list = [];
            try {
                list = global.speechSynthesis.getVoices() || [];
            } catch (e) {
                list = [];
            }
            if (list.length > 0) {
                this.voices = list;
                this.voicesLoaded = true;
            }
            return this.voices;
        },

        /** 注册：语音包异步就绪后再刷新一次 */
        bindVoicesChanged() {
            if (!this.supported() || this.bound) {
                return;
            }
            this.bound = true;
            this.loadVoices();
            global.speechSynthesis.addEventListener('voiceschanged', () => this.loadVoices());
        },

        /**
         * 挑一个最合适的语音：
         * 1) 语言标签完全一致（en-US / en-GB）
         * 2) 退而求其次：任意英语语音
         * 3) 都没有就交给浏览器，按 utterance.lang 自己选
         */
        pickVoice(lang) {
            const target = normalizeLang(lang);
            const english = this.voices.filter((voice) =>
                normalizeLang(voice.lang).indexOf('en') === 0
            );
            if (english.length === 0) {
                return null;
            }
            const exact = english.filter((voice) => normalizeLang(voice.lang) === target);
            if (exact.length > 0) {
                return exact[0];
            }
            return english[0];
        },

        /** 本机装了哪些「精确匹配」的发音（用于设置里的提示） */
        exactVoices() {
            return LANGS.filter((lang) => this.voices.some((voice) =>
                normalizeLang(voice.lang) === normalizeLang(lang)
            ));
        },

        /* ---------------- 配置 ---------------- */

        setLang(lang) {
            this.lang = normalizeLang(lang) === 'en-gb' ? 'en-GB' : DEFAULT_LANG;
            return this.lang;
        },

        setRate(rate) {
            const value = parseFloat(rate);
            this.rate = isNaN(value) ? DEFAULT_RATE : Math.min(10, Math.max(0.1, value));
            return this.rate;
        },

        /** 按设置里的值初始化自身 */
        apply(settings) {
            if (!settings) {
                return this;
            }
            this.setLang(settings.voiceLang);
            this.setRate(settings.speechRate);
            this.bindVoicesChanged();
            return this;
        },

        /* ---------------- 朗读 ---------------- */

        /**
         * 朗读一段文本（一般是单个单词）
         * @param {string} text
         * @returns {boolean} 是否成功发起朗读
         */
        speak(text) {
            const content = String(text || '').trim();
            if (!content || !this.supported()) {
                return false;
            }
            try {
                const synth = global.speechSynthesis;

                // 先掐掉上一条，避免快速切词时排成一长串
                synth.cancel();

                const utterance = new global.SpeechSynthesisUtterance(content);
                // 关键：必须显式声明语言，浏览器才知道要用英语的音素来读
                utterance.lang = this.lang;
                utterance.rate = this.rate;

                if (this.voices.length === 0) {
                    this.loadVoices();
                }
                const voice = this.pickVoice(this.lang);
                if (voice) {
                    utterance.voice = voice;
                }

                synth.speak(utterance);
                return true;
            } catch (e) {
                return false;
            }
        },

        /** 停止朗读（退出背单词、切页面时调用） */
        cancel() {
            if (!this.supported()) {
                return;
            }
            try {
                global.speechSynthesis.cancel();
            } catch (e) {
                /* 忽略 */
            }
        }
    };

    global.TTS = TTS;
})(window);
