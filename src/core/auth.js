/**
 * 推妖镜 BotZapper · 会话凭据
 *
 * WEB_BEARER 是 X 网页端的公开 bearer token：所有访客浏览器对 x.com 的
 * API 请求都携带同一常量值，随页面 JS 分发，不是私密凭据。
 * ct0（csrf）运行时从用户 cookie 中读取，不落盘。
 */
(function (root) {
  'use strict';

  var api = {
    WEB_BEARER: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    BLOCK_PATH: '/i/api/1.1/blocks/create.json',

    /** 把 fetch Response 映射为队列可消费的状态码 */
    mapResponse: function (res) {
      if (res.ok) return { status: 'blocked' };
      if (res.status === 429) return { status: 'rate_limited' };
      if (res.status === 404) return { status: 'not_found' };
      if (res.status === 401 || res.status === 403) return { status: 'auth_error' };
      return { status: 'failed' };
    }
  };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.auth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
