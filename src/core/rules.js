/**
 * 推妖镜 BotZapper · 公共规则库 v1（内置默认词库）
 *
 * 设计要点：
 *  - 评分制：单词库命中只是加分，总分过阈值才标黄，防止单词误杀
 *  - 权重语义：4=强信号（单词命中即可标黄）2=中信号（两个组合才标黄）1=弱信号（辅助加权）
 *  - 所有短语规则匹配 compact 形态（已去空格/标点/全角），天然对抗「看.我.主.页」式插空
 *  - 词库全文公开。命中标注仅是提示，拉黑永远由用户手动确认
 */
(function (root) {
  'use strict';

  // S=强信号(4) M=中信号(2) W=弱信号(1)
  function S(key, pattern, label) { return { key: key, weight: 4, pattern: pattern, label: label }; }
  function M(key, pattern, label) { return { key: key, weight: 2, pattern: pattern, label: label }; }
  function W(key, pattern, label) { return { key: key, weight: 1, pattern: pattern, label: label }; }

  var textRules = [
    // —— 色情引流（强信号）——
    S('yuepao', '约炮', '色情引流'), S('yuanjiao', '援交', '色情引流'),
    S('shangmen', '上门服务', '色情引流'), S('tongchengyue', '同城约', '色情引流'),
    S('mianfeikanpian', '免费看片', '色情引流'), S('kanpianwangzhi', '看片网址', '色情引流'),
    S('huangpian', '黄片', '色情引流'), S('fuliji', '福利姬', '色情引流'),
    S('xueshengmei', '学生妹', '色情引流'), S('weinuo', '外围女', '色情引流'),
    S('baoye', '包夜', '色情引流'), S('seqingwangzhan', '色情网站', '色情引流'),
    S('qingsewang', '情色网', '色情引流'),
    S('freenudes', 'freenudes', '色情引流'), S('nudesinbio', 'nudesinbio', '色情引流'),
    S('escortservice', 'escortservice', '色情引流'),
    // —— 2026-09-16 真实样本补充 ——
    S('zhaopaoyou', '找炮友', '色情引流'), M('paoyou', '炮友', '色情引流'),
    S('pochu', '破处', '色情引流'),
    M('dianzhuye', '点主页', '主页导流'), M('zhijinrushenti', '只进入身体', '机器复读'),
    // 推特中文圈最经典的机器复读文案（「我福不黑不信你看」），
    // 单独仅 2 分（真人玩梗引用不误杀），与复读/昵称信号组合即触发
    M('wofubuhei', '我福不黑', '机器复读'),
    // 「太阳射不进去的地方你可以」同族复读文案（2026-09-17 真实样本）
    M('taiyangshe', '太阳射不进去', '机器复读'),
    // —— 导流话术（中信号）——
    M('kanwozhuye', '看我主页', '主页导流'), M('zhuyeyou', '主页有', '主页导流'),
    M('kanzhiding', '看置顶', '主页导流'), M('zhidingyou', '置顶有', '主页导流'),
    M('kanjianjie', '看简介', '主页导流'), M('jianjieyou', '简介有', '主页导流'),
    M('siwoyou', '私我有', '私信引流'), M('sixinling', '私信领', '私信引流'),
    M('jiawei', '加微', '站外导流'), M('weixin2', '威信', '站外导流'),
    M('lvpaopao', '绿泡泡', '站外导流'), M('lvseapp', '绿色软件', '站外导流'),
    M('dianbaoqun', '电报群', '站外导流'), M('dianbaohao', '电报号', '站外导流'),
    M('feijihao', '飞机号', '站外导流'), M('tgun', 'tg群', '站外导流'),
    M('qqun', '企鹅群', '站外导流'), M('weiqun', '微信群', '站外导流'),
    M('koukou', '扣扣', '站外导流'),
    // —— 拼音/谐音变体（vx / +v / 薇信 一族）：中信号，需组合防误伤 ——
    M('vx', 'vx', '站外导流'), M('vxin', 'v信', '站外导流'),
    M('weix1', '薇信', '站外导流'), M('weix2', '薇芯', '站外导流'),
    M('weix3', '威芯', '站外导流'), M('weix4', '微芯', '站外导流'),
    W('weixinpy', 'weixin', '站外导流'),
    M('mianfeiling', '免费领', '福利钩子'), M('lingfuli', '领福利', '福利钩子'),
    M('xiandaibu', '内部线报', '福利钩子'),
    M('daidan', '带单', '金融诈骗'), M('dainihuiben', '带你回本', '金融诈骗'),
    M('laoshidaini', '老师带你', '金融诈骗'), M('chuu', '出u', '金融诈骗'),
    M('shouu', '收u', '金融诈骗'),
    M('daishua', '代刷', '刷单兼职'), M('shuadan', '刷单', '刷单兼职'),
    M('jianzhirijie', '兼职日结', '刷单兼职'), M('rijiezhao', '日结招', '刷单兼职'),
    M('checkmybio', 'checkmybio', '主页导流'), M('clickmyprofile', 'clickmyprofile', '主页导流'),
    M('cryptosignals', 'cryptosignals', '金融诈骗'),
    M('investmentopportunity', 'investmentopportunity', '金融诈骗'),
    M('guaranteedprofit', 'guaranteedprofit', '金融诈骗'),
    M('doubleyour', 'doubleyour', '金融诈骗'),
    // —— 弱信号（辅助加权）——
    W('fuli', '福利', '疑似钩子'), W('sixinx', '私信', '疑似引流'),
    W('xianbao', '线报', '疑似钩子'), W('kongtou', '空投', '金融诈骗'),
    W('yijishichang', '一级市场', '金融诈骗'), W('gendan', '跟单', '金融诈骗'),
    W('kongjiang', '空降', '疑似引流'), W('shangche', '上车', '疑似钩子'),
    W('jianzhi', '兼职', '刷单兼职'), W('rijie', '日结', '刷单兼职'),
    W('telegram', 'telegram', '站外导流'), W('whatsapp', 'whatsapp', '站外导流'),
    W('giveaway', 'giveaway', '疑似钩子'), W('onlyfans', 'onlyfans', '色情引流'),
    W('linkinbio', 'linkinbio', '主页导流'), W('tongcheng', '同城', '疑似引流')
  ].map(function (r) { return { key: r.key, weight: r.weight, label: r.label, pattern: r.pattern }; });

  // 正则规则：匹配 norm 形态（保留标点，供 URL 类模式使用）
  var regexRules = [
    { key: 'tme', weight: 2, label: '站外导流', re: /t\.me\//i },
    // 「+v / 加v / +vx」：+ 与 v 在 compact 中会失散，只能匹配保留标点的 norm 形态；
    // 尾部负向断言排除 vip/vo 之类的普通词
    { key: 'plusv', weight: 2, label: '站外导流', re: /(?:\+|加)\s*v(?:x)?(?![a-z0-9])/i },
    { key: 'shortlink', weight: 1, label: '短链可疑', re: /(?:bit\.ly|cutt\.ly|tinyurl|is\.gd|shorte\.st|adf\.ly|clck\.ru|rb\.gy|ow\.ly|buff\.ly|shorturl\.at)\//i },
    { key: 'ofsite', weight: 2, label: '色情引流', re: /(?:onlyfans\.com|fansly\.com)/i }
  ];

  // 昵称规则：匹配昵称 compact 形态
  var nameRules = [
    { key: 'n_fuli', weight: 2, label: '昵称可疑', pattern: '福利' },
    { key: 'n_shangmen', weight: 2, label: '昵称可疑', pattern: '上门' },
    { key: 'n_yuepa', weight: 2, label: '昵称可疑', pattern: '约啪' },
    { key: 'n_yuanjiao', weight: 2, label: '昵称可疑', pattern: '援交' },
    { key: 'n_jianzhi', weight: 2, label: '昵称可疑', pattern: '兼职' },
    { key: 'n_bocai', weight: 2, label: '博彩引流', pattern: '博彩' },
    { key: 'n_qipai', weight: 2, label: '博彩引流', pattern: '棋牌' },
    { key: 'n_aomen', weight: 1, label: '博彩引流', pattern: '澳门' },
    { key: 'n_weixin', weight: 2, label: '昵称可疑', pattern: '威信' },
    { key: 'n_jiawei', weight: 2, label: '昵称可疑', pattern: '加微' },
    { key: 'n_weirao', weight: 2, label: '昵称可疑', pattern: '外围' },
    { key: 'n_ziyuanqun', weight: 2, label: '昵称可疑', pattern: '资源群' },
    { key: 'n_miaodao', weight: 2, label: '金融诈骗', pattern: '秒到' },
    { key: 'n_taoli', weight: 2, label: '金融诈骗', pattern: '套利' },
    { key: 'n_fanyong', weight: 2, label: '金融诈骗', pattern: '返佣' },
    { key: 'n_kaihu', weight: 2, label: '金融诈骗', pattern: '开户' },
    { key: 'n_beitou', weight: 2, label: '金融诈骗', pattern: '倍投' },
    { key: 'n_daoshi', weight: 1, label: '金融诈骗', pattern: '导师' },
    // —— 2026-09-16 真实样本补充 ——
    { key: 'n_zhaopaoyou', weight: 4, label: '色情引流', pattern: '找炮友' },
    { key: 'n_paoyou', weight: 2, label: '色情引流', pattern: '炮友' },
    { key: 'n_pochu', weight: 4, label: '色情引流', pattern: '破处' },
    { key: 'n_dianzhuye', weight: 2, label: '主页导流', pattern: '点主页' },
    { key: 'n_nvda', weight: 1, label: '昵称可疑', pattern: '女大' },
    { key: 'n_tongcheng', weight: 1, label: '疑似引流', pattern: '同城' },
    // —— 2026-09-17 真实样本补充：处男/无偿 一族免费色情引流昵称 ——
    // 只做昵称规则不做正文规则：「我还是处男」式自嘲是真话，昵称场景几乎全是诱饵
    { key: 'n_chunan', weight: 2, label: '色情引流', pattern: '处男' },
    { key: 'n_wuchang', weight: 1, label: '昵称可疑', pattern: '无偿' }
  ];

  var metaRules = {
    invisible: { key: 'invisible', weight: 1, label: '隐形字符' },
    fwUrl: { key: 'fwurl', weight: 3, label: '全角伪装链接' },
    nameDigits: { key: 'namedigits', weight: 1, label: '昵称含联系号' },
    // 同页多账号复读同一文本（≥3 次），机器刷评的强特征；作为组合信号(+2)防梗刷屏误伤
    repetition: { key: 'repetition', weight: 2, label: '同页复读' }
  };

  var api = {
    version: '2026.09.17.2',
    textRules: textRules,
    regexRules: regexRules,
    nameRules: nameRules,
    metaRules: metaRules,

    /**
     * 校验远程词库 JSON（规则热更新）。
     * 安全约束：远程规则只接受纯文本 pattern（compact 后 indexOf 匹配），
     * 不接受正则——避免远端注入 ReDoS。权重钳制到 {1,2,4}，数量设上限。
     * @returns {{ok:boolean, reason?:string, version?:string, textRules?:Array, nameRules?:Array}}
     */
    validateRemote: function (data) {
      if (!data || typeof data !== 'object') return { ok: false, reason: 'not_object' };
      var version = String(data.version || '').slice(0, 40);
      if (!version) return { ok: false, reason: 'no_version' };

      function pickWeight(w) {
        var n = Number(w);
        return (n === 1 || n === 2 || n === 4) ? n : 2;
      }
      function pickList(raw, max, label) {
        var out = [];
        if (!Array.isArray(raw)) return out;
        for (var i = 0; i < raw.length && out.length < max; i++) {
          var item = raw[i];
          var pattern = item && typeof item.pattern === 'string' ? item.pattern.trim().slice(0, 40) : '';
          if (!pattern) continue;
          out.push({ pattern: pattern, weight: pickWeight(item.weight), label: label });
        }
        return out;
      }

      return {
        ok: true,
        version: version,
        textRules: pickList(data.textRules, 400, '远程词库'),
        nameRules: pickList(data.nameRules, 200, '远程词库')
      };
    }
  };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.rules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
