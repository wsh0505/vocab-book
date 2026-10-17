/* =============================================================
 * cover.js —— 单词书封面
 * 支持：预设纯色、简单图案、从相册上传图片（自动压缩）
 * 封面风格保持干净克制，不使用花哨效果
 * ============================================================= */
(function (global) {
    'use strict';

    /** 预设封面配色（低饱和纸感） */
    const COLORS = [
        '#cfd8c8', '#e3d7c4', '#d9cbd6', '#c8d3dc',
        '#e0cfc2', '#d6d0c1', '#cbd6cc', '#e2d3d3',
        '#c7d1b8', '#dcc9bd'
    ];

    /** 简单图案：用 CSS 渐变实现，颜色取自封面底色上的半透明白 */
    const PATTERNS = {
        plain: {
            label: '纯色',
            css: ''
        },
        dots: {
            label: '圆点',
            css: 'radial-gradient(rgba(255,255,255,.55) 1.8px, transparent 2px) 0 0 / 15px 15px'
        },
        lines: {
            label: '斜纹',
            css: 'repeating-linear-gradient(45deg, rgba(255,255,255,.34) 0 2px, transparent 2px 11px)'
        },
        grid: {
            label: '格纹',
            css: 'linear-gradient(rgba(255,255,255,.30) 1px, transparent 1px) 0 0 / 17px 17px,' +
                 'linear-gradient(90deg, rgba(255,255,255,.30) 1px, transparent 1px) 0 0 / 17px 17px'
        },
        stripes: {
            label: '横条',
            css: 'repeating-linear-gradient(0deg, rgba(255,255,255,.26) 0 6px, transparent 6px 15px)'
        },
        waves: {
            label: '波纹',
            css: 'repeating-radial-gradient(circle at 50% 118%, rgba(255,255,255,.30) 0 7px,' +
                 ' transparent 7px 16px)'
        },
        cross: {
            label: '交叉',
            css: 'repeating-linear-gradient(45deg, rgba(255,255,255,.24) 0 1.5px, transparent 1.5px 13px),' +
                 'repeating-linear-gradient(-45deg, rgba(255,255,255,.24) 0 1.5px, transparent 1.5px 13px)'
        }
    };

    const Cover = {
        COLORS: COLORS,
        PATTERNS: PATTERNS,

        /** 新建单词书时的默认封面（按顺序轮换颜色，第二本起带圆点图案） */
        defaultCover(index) {
            const safeIndex = typeof index === 'number' ? index : 0;
            return {
                type: 'pattern',
                color: COLORS[safeIndex % COLORS.length],
                pattern: safeIndex % 2 === 0 ? 'dots' : 'lines',
                image: null
            };
        },

        /** 生成封面背景样式（用于 style 属性） */
        style(cover) {
            const safe = cover || this.defaultCover(0);
            if (safe.type === 'image' && safe.image) {
                // dataURL 只含 base64 字符，这里不加引号，避免写进 HTML 的 style 属性时被截断
                return 'background-image:linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,.52)),' +
                    'url(' + safe.image + ');' +
                    'background-size:cover;background-position:center;background-color:' + safe.color + ';';
            }
            if (safe.type === 'pattern') {
                const pattern = PATTERNS[safe.pattern] ? PATTERNS[safe.pattern].css : '';
                if (!pattern) {
                    return 'background-color:' + safe.color + ';';
                }
                return 'background-color:' + safe.color + ';background-image:' + pattern + ';';
            }
            return 'background-color:' + safe.color + ';';
        },

        /** 图案预览样式（封面编辑器里的色块） */
        patternPreview(color, key) {
            const pattern = PATTERNS[key] ? PATTERNS[key].css : '';
            return 'background-color:' + color + ';' +
                (pattern ? 'background-image:' + pattern + ';background-size:15px 15px;' : '');
        },

        /**
         * 压缩图片：等比缩放到最大边不超过 maxSize，转成 JPEG
         * @param {File} file   用户选择的图片
         * @param {Number} maxSize 最大边长（像素）
         * @returns {Promise<String>} dataURL
         */
        compressImage(file, maxSize) {
            const limit = maxSize || 420;
            return new Promise((resolve, reject) => {
                if (!file || !/^image\//.test(file.type)) {
                    reject(new Error('不是图片文件'));
                    return;
                }
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('读取失败'));
                reader.onload = () => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('图片解码失败'));
                    img.onload = () => {
                        const scale = Math.min(1, limit / Math.max(img.width, img.height));
                        const width = Math.max(1, Math.round(img.width * scale));
                        const height = Math.max(1, Math.round(img.height * scale));
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, width, height);
                        ctx.drawImage(img, 0, 0, width, height);
                        resolve(canvas.toDataURL('image/jpeg', 0.72));
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        }
    };

    global.Cover = Cover;
})(window);
