/**
 * Mrky Grammar Explainer — Local Rule-Based Engine (Enhanced v2)
 * محرك تحليل لغوي محلي مدمج — الإصدار المحسّن
 * ──────────────────────────────────────────────────────────────
 * يوفر تحليلاً نحوياً، صوتياً، واصطلاحياً مختصراً للكلمة في سياق الجملة.
 * يعتمد على compromise.js + قواعد لغوية متقدمة مبرمجة يدوياً.
 * لا يحتاج اتصال بالإنترنت ولا مفاتيح API — يعمل محلياً بالكامل.
 *
 * التحسينات في v2:
 * - كاشف الأفعال المركبة (Phrasal Verbs)
 * - كاشف التعبيرات الاصطلاحية (Idioms)
 * - تحليل أزمنة الفعل المركبة (Perfect, Progressive, etc.)
 * - قواعد نطق حرف S الأخير (/s/ vs /z/)
 * - قواعد الحروف المزدوجة (Diphthongs: oo, ee, ou, etc.)
 * - معالجة الكلمات متعددة الوظائف (Ambiguity Resolution)
 */
import nlp from 'compromise';

// ══════════════════════════════════════════════════
// 1. القواعد النحوية الأساسية (Grammar Rules)
// ══════════════════════════════════════════════════

const GRAMMAR_RULES = {
  // ─── الأفعال ───
  PastTense:    { role: 'فعل ماضي',      why: 'يدل على حدث وقع وانتهى في الماضي.' },
  PresentTense: { role: 'فعل مضارع',     why: 'يدل على حدث يحصل الآن أو بشكل متكرر.' },
  FutureTense:  { role: 'فعل مستقبل',    why: 'يدل على حدث سيحصل لاحقاً.' },
  Gerund:       { role: 'فعل مستمر (ing)', why: 'صيغة الاستمرار، تدل على حدث جارٍ أو تستخدم كاسم.' },
  Infinitive:   { role: 'مصدر (to + فعل)', why: 'الفعل في صيغته الأساسية، غالباً بعد to.' },
  Verb:         { role: 'فعل',            why: 'يعبّر عن حدث أو فعل أو حالة.' },
  Modal:        { role: 'فعل مساعد شرطي', why: 'يُضاف قبل الفعل الرئيسي لإظهار القدرة أو الاحتمال أو الإلزام.' },
  Auxiliary:    { role: 'فعل مساعد',      why: 'يساعد في تكوين الأزمنة أو الأسئلة أو النفي.' },
  Participle:   { role: 'اسم فاعل/مفعول', why: 'صيغة مشتقة من الفعل تُستخدم كصفة أو في الأزمنة المركبة.' },

  // ─── الأسماء ───
  Noun:         { role: 'اسم',            why: 'يدل على شيء أو شخص أو مكان أو فكرة.' },
  Singular:     { role: 'اسم مفرد',       why: 'يشير إلى شيء واحد فقط.' },
  Plural:       { role: 'اسم جمع',        why: 'يشير إلى أكثر من شيء واحد.' },
  ProperNoun:   { role: 'اسم علم',        why: 'اسم خاص لشخص أو مكان أو علامة تجارية (يبدأ بحرف كبير).' },
  Possessive:   { role: 'صيغة ملكية',     why: 'يدل على أن شيئاً يملكه شخص أو شيء آخر (مثل \'s).' },
  Uncountable:  { role: 'اسم غير معدود',  why: 'لا يمكن عدّه مباشرة (مثل: water, information).' },

  // ─── الصفات ───
  Adjective:    { role: 'صفة',            why: 'تصف الاسم الذي بجوارها وتعطي معلومات عنه.' },
  Comparative:  { role: 'صفة مقارنة',     why: 'تقارن بين شيئين (أكثر/أقل من).' },
  Superlative:  { role: 'صفة تفضيل',      why: 'تدل على أن شيئاً هو الأعلى/الأدنى في مجموعته.' },

  // ─── الظروف ───
  Adverb:       { role: 'ظرف/حال',        why: 'يصف كيفية أو زمان أو مكان حدوث الفعل.' },

  // ─── أدوات أخرى ───
  Determiner:   { role: 'أداة تعريف/تنكير', why: 'تسبق الاسم لتحدده (the, a, this, that).' },
  Conjunction:  { role: 'أداة ربط',       why: 'تربط بين جملتين أو كلمتين (and, but, or).' },
  Preposition:  { role: 'حرف جر',         why: 'يربط الاسم بباقي الجملة ويبين العلاقة (in, on, at, by).' },
  Pronoun:      { role: 'ضمير',           why: 'يحل محل الاسم لتجنب التكرار (he, she, it, they).' },
  QuestionWord: { role: 'أداة استفهام',    why: 'تُستخدم لبدء السؤال (what, where, when, how, why).' },
  Negative:     { role: 'أداة نفي',        why: 'تنفي الفعل أو الجملة (not, never, no).' },
  Expression:   { role: 'تعبير اصطلاحي',  why: 'عبارة لها معنى خاص مختلف عن معنى كلماتها المنفردة.' },
  Abbreviation: { role: 'اختصار',          why: 'شكل مختصر لكلمة أو عبارة أطول.' },
  Contraction:  { role: 'اختصار دمجي',    why: 'دمج كلمتين معاً بحذف حرف (مثل: don\'t = do not).' },
};

// ══════════════════════════════════════════════════
// 2. الأفعال المركبة (Phrasal Verbs Database)
// ══════════════════════════════════════════════════

/**
 * أشهر 80+ فعل مركب في اللغة الإنجليزية.
 * الكلمة الأولى = الفعل الرئيسي، الثانية = الجسيم (particle).
 * عند اكتشافها يُنبَّه المتعلم أن المعنى مختلف عن الكلمتين منفصلتين.
 */
const PHRASAL_VERBS = {
  'break down':  'يتعطل / ينهار — معنى مختلف عن break + down.',
  'break up':    'ينفصل / يتفكك.',
  'break out':   'يندلع / ينتشر فجأة.',
  'bring up':    'يطرح موضوعاً / يربّي طفلاً.',
  'call off':    'يُلغي.',
  'carry on':    'يستمر.',
  'carry out':   'يُنفّذ / يقوم بتنفيذ شيء.',
  'check in':    'يسجّل الدخول (فندق/مطار).',
  'check out':   'يغادر / يتفحّص شيئاً.',
  'come across': 'يصادف شيئاً بالصدفة.',
  'come up':     'يظهر / يُطرح (موضوع).',
  'cut off':     'يقطع / يفصل.',
  'figure out':  'يكتشف / يفهم.',
  'fill in':     'يملأ (استمارة) / يُعوّض عن شخص.',
  'fill out':    'يملأ (نموذج).',
  'find out':    'يكتشف / يعرف.',
  'get along':   'ينسجم مع شخص.',
  'get away':    'يهرب / يبتعد.',
  'get over':    'يتغلب على / يتعافى.',
  'get up':      'ينهض / يستيقظ.',
  'give in':     'يستسلم.',
  'give up':     'يتخلى عن / يستسلم.',
  'go on':       'يستمر.',
  'go over':     'يراجع.',
  'grow up':     'يكبر / ينضج.',
  'hand in':     'يسلّم (واجب/مستند).',
  'hold on':     'ينتظر / يتمسّك.',
  'keep on':     'يستمر.',
  'keep up':     'يواكب / يحافظ على المستوى.',
  'let down':    'يخذل.',
  'look after':  'يعتني بـ.',
  'look for':    'يبحث عن.',
  'look forward':'يتطلع إلى.',
  'look into':   'يحقق في / يبحث في.',
  'look up':     'يبحث عن (في قاموس) / ينظر للأعلى.',
  'make up':     'يختلق / يتصالح / يشكّل.',
  'move on':     'يمضي قدماً.',
  'pass away':   'يتوفى (تعبير مهذّب عن الموت).',
  'pass out':    'يفقد الوعي / يوزّع.',
  'pick up':     'يلتقط / يصطحب شخصاً.',
  'point out':   'يشير إلى / ينبّه.',
  'pull off':    'ينجح في شيء صعب.',
  'put off':     'يؤجّل.',
  'put on':      'يرتدي / يشغّل.',
  'put up with': 'يتحمّل.',
  'run into':    'يصادف بالصدفة.',
  'run out':     'ينفد / ينتهي.',
  'set up':      'يؤسس / يجهّز.',
  'show up':     'يظهر / يحضر.',
  'shut down':   'يغلق / يوقف.',
  'sign up':     'يسجّل / ينضم.',
  'sort out':    'يحل / يرتّب.',
  'stand out':   'يبرز / يتميّز.',
  'take off':    'يقلع (طائرة) / يخلع (ملابس).',
  'take on':     'يتولّى مهمة.',
  'take over':   'يستولي / يتسلّم.',
  'take up':     'يبدأ ممارسة هواية / يشغل مساحة.',
  'throw away':  'يرمي / يتخلص من.',
  'turn down':   'يرفض / يخفض الصوت.',
  'turn off':    'يطفئ.',
  'turn on':     'يشغّل.',
  'turn out':    'يتضح / ينتهي بنتيجة.',
  'turn up':     'يظهر / يرفع الصوت.',
  'work out':    'يتمرّن / يجد حلاً / ينجح.',
  'wrap up':     'يُنهي / يختتم.',
};

// ══════════════════════════════════════════════════
// 3. التعبيرات الاصطلاحية الشائعة (Common Idioms)
// ══════════════════════════════════════════════════

const IDIOMS = {
  'kick the bucket':   '⚠️ تعبير اصطلاحي: يموت (غير رسمي).',
  'break the ice':     '⚠️ تعبير اصطلاحي: يكسر الحاجز في محادثة.',
  'hit the road':      '⚠️ تعبير اصطلاحي: ينطلق / يذهب.',
  'piece of cake':     '⚠️ تعبير اصطلاحي: شيء سهل جداً.',
  'under the weather': '⚠️ تعبير اصطلاحي: مريض / لا يشعر بخير.',
  'cost an arm':       '⚠️ تعبير اصطلاحي: مكلّف جداً.',
  'let the cat out':   '⚠️ تعبير اصطلاحي: يكشف سراً.',
  'once in a blue moon':'⚠️ تعبير اصطلاحي: نادراً جداً.',
  'on the same page':  '⚠️ تعبير اصطلاحي: متفقون / على نفس الرأي.',
  'the last straw':    '⚠️ تعبير اصطلاحي: القشة التي قصمت ظهر البعير.',
  'beat around the bush':'⚠️ تعبير اصطلاحي: يُراوغ ولا يدخل في الموضوع.',
  'a blessing in disguise': '⚠️ تعبير اصطلاحي: نعمة مُتنكّرة.',
  'better late than never': '⚠️ تعبير اصطلاحي: أن تأتي متأخراً أفضل من ألا تأتي.',
  'bite the bullet':   '⚠️ تعبير اصطلاحي: يتحمّل الألم بشجاعة.',
  'burn bridges':      '⚠️ تعبير اصطلاحي: يقطع العلاقات نهائياً.',
  'call it a day':     '⚠️ تعبير اصطلاحي: يتوقف عن العمل (كفاية لليوم).',
  'get out of hand':   '⚠️ تعبير اصطلاحي: يخرج عن السيطرة.',
  'hang in there':     '⚠️ تعبير اصطلاحي: اصبر / تمسّك.',
  'miss the boat':     '⚠️ تعبير اصطلاحي: يفوّت الفرصة.',
  'pull someone\'s leg':'⚠️ تعبير اصطلاحي: يمزح مع شخص.',
  'speak of the devil':'⚠️ تعبير اصطلاحي: جينا على ذكره (وجاء)!',
  'spill the beans':   '⚠️ تعبير اصطلاحي: يفشي السر.',
  'stab in the back':  '⚠️ تعبير اصطلاحي: يطعن في الظهر / يخون.',
  'time flies':        '⚠️ تعبير اصطلاحي: الوقت يمر بسرعة.',
  'wrap your head':    '⚠️ تعبير اصطلاحي: يفهم / يستوعب شيئاً صعباً.',
};

// ══════════════════════════════════════════════════
// 4. أنماط السياق المتقدمة (Advanced Context Patterns)
// ══════════════════════════════════════════════════

const CONTEXT_PATTERNS = [
  {
    pattern: /\b(to)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد "to" → غالباً فعل في صيغة المصدر (Infinitive).',
  },
  {
    pattern: /\b(the|a|an|this|that|my|your|his|her|its|our|their)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد أداة تعريف → تعمل هنا كاسم.',
  },
  {
    pattern: /\b(is|are|was|were|been|being)\s+(\w+ing)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد فعل مساعد + ing → صيغة استمرار (Progressive).',
  },
  {
    pattern: /\b(is|are|was|were|seem|look|feel|become)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد فعل ربط → تعمل كصفة أو خبر للمبتدأ.',
  },
  {
    pattern: /\b(very|really|quite|extremely|so|too)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'سبقتها كلمة تعزيز (very/really) → هذه صفة أو ظرف.',
  },
  {
    pattern: /\b(\w+ly)\b/gi,
    check: (word, match) => match[1].toLowerCase() === word.toLowerCase() && word.length > 3,
    hint: 'تنتهي بـ -ly → غالباً ظرف يصف كيفية حدوث الفعل.',
  },
  // ─── أنماط جديدة v2 ───
  {
    pattern: /\b(has|have|had)\s+(\w+ed|\w+en)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد has/have/had → هذا التصريف الثالث (Past Participle) ضمن زمن تام (Perfect Tense).',
  },
  {
    pattern: /\b(will|shall|would|could|might)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'جاءت بعد فعل مساعد شرطي → الفعل في صيغته الأساسية (Base Form).',
  },
  {
    pattern: /\b(more|most)\s+(\w+)\b/gi,
    check: (word, match) => match[2].toLowerCase() === word.toLowerCase(),
    hint: 'سبقتها more/most → صفة في صيغة المقارنة أو التفضيل.',
  },
  {
    pattern: /\b(\w+)\s+(and|or|but)\s+(\w+)\b/gi,
    check: (word, match) => match[1].toLowerCase() === word.toLowerCase() || match[3].toLowerCase() === word.toLowerCase(),
    hint: 'مربوطة بأداة ربط (and/or/but) → غالباً نفس نوع الكلمة المجاورة.',
  },
];

// ══════════════════════════════════════════════════
// 5. تحليل أزمنة الفعل المتقدمة (Advanced Tense Analysis)
// ══════════════════════════════════════════════════

/**
 * يكتشف الأزمنة المركبة بتحليل الكلمات المحيطة بالفعل.
 * مثلاً: "has been working" = Present Perfect Continuous.
 */
const TENSE_PATTERNS = [
  // Present Perfect: has/have + past participle
  { regex: /\b(has|have)\s+(\w+ed|\w+en)\b/gi,
    check: 2, tense: 'المضارع التام (Present Perfect)',
    explain: 'حدث بدأ في الماضي وله أثر أو صلة بالحاضر.' },
  // Past Perfect: had + past participle
  { regex: /\bhad\s+(\w+ed|\w+en)\b/gi,
    check: 1, tense: 'الماضي التام (Past Perfect)',
    explain: 'حدث وقع قبل حدث آخر في الماضي.' },
  // Future Perfect: will have + past participle
  { regex: /\bwill\s+have\s+(\w+ed|\w+en)\b/gi,
    check: 1, tense: 'المستقبل التام (Future Perfect)',
    explain: 'حدث سيكون قد اكتمل قبل وقت محدد في المستقبل.' },
  // Present Perfect Continuous: has/have been + -ing
  { regex: /\b(has|have)\s+been\s+(\w+ing)\b/gi,
    check: 2, tense: 'المضارع التام المستمر (Present Perfect Continuous)',
    explain: 'حدث بدأ في الماضي ولا يزال مستمراً حتى الآن.' },
  // Past Perfect Continuous: had been + -ing
  { regex: /\bhad\s+been\s+(\w+ing)\b/gi,
    check: 1, tense: 'الماضي التام المستمر (Past Perfect Continuous)',
    explain: 'حدث كان مستمراً قبل حدث آخر في الماضي.' },
  // Present Continuous: is/are/am + -ing
  { regex: /\b(is|are|am)\s+(\w+ing)\b/gi,
    check: 2, tense: 'المضارع المستمر (Present Continuous)',
    explain: 'حدث يجري الآن في هذه اللحظة.' },
  // Past Continuous: was/were + -ing
  { regex: /\b(was|were)\s+(\w+ing)\b/gi,
    check: 2, tense: 'الماضي المستمر (Past Continuous)',
    explain: 'حدث كان جارياً في لحظة معينة في الماضي.' },
  // Passive Voice: is/are/was/were + past participle
  { regex: /\b(is|are|was|were|been|be)\s+(\w+ed|\w+en)\b/gi,
    check: 2, tense: 'مبني للمجهول (Passive Voice)',
    explain: 'الفاعل مجهول أو غير مهم — التركيز على الحدث نفسه.' },
];

// ══════════════════════════════════════════════════
// 6. قواعد الأحرف الصامتة (Silent Letters)
// ══════════════════════════════════════════════════

const SILENT_LETTER_RULES = [
  { regex: /^kn/i,           letter: 'K', hint: 'حرف K صامت (لا يُنطق) عندما يأتي قبل N في بداية الكلمة.' },
  { regex: /^wr/i,           letter: 'W', hint: 'حرف W صامت عندما يأتي قبل R في بداية الكلمة.' },
  { regex: /^gn|gn$/i,       letter: 'G', hint: 'حرف G صامت عندما يأتي مع N.' },
  { regex: /mb$/i,           letter: 'B', hint: 'حرف B صامت عندما يأتي بعد M في نهاية الكلمة.' },
  { regex: /bt$/i,           letter: 'B', hint: 'حرف B صامت عندما يأتي قبل T في نهاية الكلمة.' },
  { regex: /^(hour|honest|honour|honor|heir|herb)s?$/i, letter: 'H', hint: 'حرف H صامت في بداية هذه الكلمة.' },
  { regex: /^(half|calf|calm|palm|talk|walk|folk|yolk|could|would|should|salmon)s?$/i, letter: 'L', hint: 'حرف L صامت في هذه الكلمة.' },
  { regex: /^(ps|pn|pt)/i,   letter: 'P', hint: 'حرف P صامت عندما يأتي قبل S أو N أو T في البداية.' },
  { regex: /^(listen|castle|whistle|fasten|often|mortgage|christmas|soften|hasten|nestle|wrestle|bustle|hustle|rustle|jostle|apostle|bristle|gristle|thistle|trestle|epistle)$/i, letter: 'T', hint: 'حرف T صامت في هذه الكلمة.' },
  { regex: /igh/i,           letter: 'GH', hint: 'حرفا GH صامتان هنا.' },
  { regex: /ough/i,          letter: 'GH', hint: 'حرفا GH غالباً صامتان في نمط -ough.' },
  { regex: /[a-z][aeiou][a-z]e$/i, letter: 'E', hint: 'حرف E الأخير "صامت" (Magic E) — لا يُنطق لكنه يُطوّل صوت الحرف المتحرك السابق.' },
  { regex: /^(wednesday|handsome|handkerchief|sandwich)$/i, letter: 'D', hint: 'حرف D صامت في هذه الكلمة.' },
  // ─── إضافات v2 ───
  { regex: /^(island|aisle|isle)$/i,  letter: 'S', hint: 'حرف S صامت في هذه الكلمة.' },
  { regex: /^(answer|sword|two)$/i,   letter: 'W', hint: 'حرف W صامت في هذه الكلمة.' },
  { regex: /^(muscle|scene|science|scissors|scent)$/i, letter: 'C', hint: 'حرف C صامت في هذه الكلمة.' },
  { regex: /^(autumn|column|hymn|damn|condemn|solemn)$/i, letter: 'N', hint: 'حرف N صامت في نهاية هذه الكلمة.' },
  { regex: /^(ghost|ghastly|ghetto|spaghetti)$/i, letter: 'H', hint: 'حرف H صامت بعد G في هذه الكلمة.' },
  { regex: /^(receipt|corps|coup|raspberry|cupboard)$/i, letter: 'P', hint: 'حرف P صامت في هذه الكلمة.' },
];

// ══════════════════════════════════════════════════
// 7. قواعد النطق المتقدمة (Enhanced Pronunciation Rules)
// ══════════════════════════════════════════════════

const PRONUNCIATION_TIPS = [
  // ─── نهايات شائعة ───
  { regex: /tion$/i,     hint: 'النهاية -tion تُنطق "شَن" (/ʃən/).' },
  { regex: /sion$/i,     hint: 'النهاية -sion تُنطق "جَن" (/ʒən/) أو "شَن" (/ʃən/).' },
  { regex: /ous$/i,      hint: 'النهاية -ous تُنطق "أَس" (/əs/).' },
  { regex: /ture$/i,     hint: 'النهاية -ture تُنطق "تشَر" (/tʃər/).' },
  { regex: /ght$/i,      hint: 'النهاية -ght: حرفا GH صامتان، فقط T تُنطق.' },
  { regex: /ible$/i,     hint: 'النهاية -ible تُنطق "إبل" (/ɪbəl/).' },
  { regex: /able$/i,     hint: 'النهاية -able تُنطق "أبل" (/eɪbəl/).' },
  { regex: /ough$/i,     hint: 'النهاية -ough لها عدة نطقات! (through=أوو, though=أو, tough=أف, cough=أوف).' },

  // ─── أصوات حرفين (Digraphs) ───
  { regex: /ph/i,        hint: 'الحرفان PH يُنطقان كـ "ف" (/f/).' },
  { regex: /^th/i,       hint: 'TH في البداية: "ذ" في الكلمات الشائعة (the, this) أو "ث" في (think, three).' },
  { regex: /^ch/i,       hint: 'الحرفان CH يُنطقان "تش" (/tʃ/) مثل chair.' },
  { regex: /sh/i,        hint: 'الحرفان SH يُنطقان "ش" (/ʃ/).' },
  { regex: /^qu/i,       hint: 'الحرفان QU يُنطقان "كو" (/kw/).' },

  // ─── حروف مزدوجة (Diphthongs & Long Vowels) — جديد v2 ───
  { regex: /oo/i,        hint: 'الحرفان OO يُنطقان "أوو" طويلة (/uː/) مثل food، أو قصيرة (/ʊ/) مثل good.' },
  { regex: /ee/i,        hint: 'الحرفان EE يُنطقان "إي" طويلة (/iː/) مثل see.' },
  { regex: /ea/i,        hint: 'الحرفان EA غالباً يُنطقان "إي" (/iː/) مثل read، وأحياناً "إ" قصيرة (/ɛ/) مثل bread.' },
  { regex: /ou/i,        hint: 'الحرفان OU يُنطقان "آو" (/aʊ/) مثل house، أو "أَ" (/ʌ/) مثل touch.' },
  { regex: /ow/i,        hint: 'الحرفان OW يُنطقان "آو" (/aʊ/) مثل cow، أو "أو" (/oʊ/) مثل show.' },
  { regex: /ai/i,        hint: 'الحرفان AI يُنطقان "إي" طويلة (/eɪ/) مثل rain.' },
  { regex: /oi|oy/i,     hint: 'الحرفان OI/OY يُنطقان "أوي" (/ɔɪ/) مثل boy, coin.' },

  // ─── بوادئ (Prefixes) ───
  { regex: /^un/i,       hint: 'البادئة un- تعني "عدم/عكس" (unhappy = غير سعيد).' },
  { regex: /^re[a-z]/i,  hint: 'البادئة re- تعني "إعادة" (rebuild = إعادة بناء).' },
  { regex: /^dis/i,      hint: 'البادئة dis- تعني "عدم/إزالة" (disagree = لا يوافق).' },
  { regex: /^mis/i,      hint: 'البادئة mis- تعني "بشكل خاطئ" (misunderstand = سوء فهم).' },
  { regex: /^pre/i,      hint: 'البادئة pre- تعني "قبل" (preview = معاينة مسبقة).' },
  { regex: /^over/i,     hint: 'البادئة over- تعني "أكثر من اللازم" (overwork = عمل مفرط).' },
  { regex: /^inter/i,    hint: 'البادئة inter- تعني "بين" (international = دولي/بين الأمم).' },
  { regex: /^sub/i,      hint: 'البادئة sub- تعني "تحت" (submarine = غواصة/تحت البحر).' },
  { regex: /^anti/i,     hint: 'البادئة anti- تعني "ضد" (antibody = جسم مضاد).' },

  // ─── لواحق (Suffixes) ───
  { regex: /less$/i,     hint: 'اللاحقة -less تعني "بدون" (homeless = بلا مأوى).' },
  { regex: /ful$/i,      hint: 'اللاحقة -ful تعني "مليء بـ" (beautiful = جميل).' },
  { regex: /ness$/i,     hint: 'اللاحقة -ness تحول الصفة إلى اسم (happiness = السعادة).' },
  { regex: /ment$/i,     hint: 'اللاحقة -ment تحول الفعل إلى اسم (movement = حركة).' },
  { regex: /ize$/i,      hint: 'اللاحقة -ize تحول الاسم/الصفة إلى فعل (organize = يُنظّم).' },
  { regex: /ify$/i,      hint: 'اللاحقة -ify تحول إلى فعل (simplify = يُبسّط).' },
  { regex: /ity$/i,      hint: 'اللاحقة -ity تحول الصفة إلى اسم (reality = الواقع).' },
  { regex: /ment$/i,     hint: 'اللاحقة -ment تحول الفعل إلى اسم (development = تطوير).' },
  { regex: /ly$/i,       hint: 'اللاحقة -ly تحول الصفة إلى ظرف (quickly = بسرعة).' },
  { regex: /er$/i,       hint: 'اللاحقة -er: فاعل (teacher = مُعلّم) أو مقارنة (bigger = أكبر).' },
  { regex: /est$/i,      hint: 'اللاحقة -est لصيغة التفضيل (biggest = الأكبر).' },
];

// ══════════════════════════════════════════════════
// 8. قواعد نطق حرف S الأخير — جديد v2
// ══════════════════════════════════════════════════

/**
 * حرف S في نهاية الكلمة ينطق بـ 3 طرق مختلفة:
 * /s/ بعد الأصوات المهموسة (voiceless): p, t, k, f, θ
 * /z/ بعد الأصوات المجهورة (voiced): b, d, g, v, m, n, l, r + حروف العلة
 * /ɪz/ بعد الأصوات الحادة (sibilants): s, z, sh, ch, x, ge, ce
 */
function explainFinalS(word) {
  const lower = word.toLowerCase();
  if (!lower.endsWith('s') || lower.length < 3) return null;

  // لا تنطبق على الكلمات التي تنتهي بـ ss (مثل class, miss)
  if (lower.endsWith('ss')) return null;

  const beforeS = lower.slice(0, -1);

  // /ɪz/ — بعد الأصوات الحادة
  if (/(?:sh|ch|ss|x|z|se|ce|ge)$/i.test(beforeS)) {
    return 'حرف S الأخير يُنطق "إز" (/ɪz/) لأن الكلمة تنتهي بصوت حاد (sibilant).';
  }

  // /s/ — بعد الأصوات المهموسة
  if (/[ptfk]$/i.test(beforeS) || /th$/i.test(beforeS)) {
    return 'حرف S الأخير يُنطق "سْ" (/s/) همساً لأن الصوت قبله مهموس (voiceless).';
  }

  // /z/ — بعد الأصوات المجهورة وحروف العلة
  if (/[bdgvmnlr]$/i.test(beforeS) || /[aeiou]$/i.test(beforeS)) {
    return 'حرف S الأخير يُنطق "ز" (/z/) لأن الصوت قبله مجهور (voiced).';
  }

  return null;
}

// ══════════════════════════════════════════════════
// 9. الدوال الرئيسية (Public API)
// ══════════════════════════════════════════════════

/**
 * يكتشف ما إذا كانت الكلمة جزءاً من فعل مركب أو تعبير اصطلاحي.
 * @param {string} word
 * @param {string} sentence
 * @returns {{ type: 'phrasal'|'idiom'|null, phrase: string, meaning: string }|null}
 */
function detectPhrasalOrIdiom(word, sentence) {
  const lower = sentence.toLowerCase();
  const wordLower = word.toLowerCase();

  // فحص التعبيرات الاصطلاحية أولاً (أولوية أعلى)
  for (const [phrase, meaning] of Object.entries(IDIOMS)) {
    if (lower.includes(phrase) && phrase.includes(wordLower)) {
      return { type: 'idiom', phrase, meaning };
    }
  }

  // فحص الأفعال المركبة
  for (const [phrase, meaning] of Object.entries(PHRASAL_VERBS)) {
    if (lower.includes(phrase) && phrase.split(' ').some(p => p === wordLower)) {
      return { type: 'phrasal', phrase, meaning };
    }
  }

  return null;
}

/**
 * يكتشف زمن الفعل المركب (Perfect, Continuous, Passive).
 * @param {string} word
 * @param {string} sentence
 * @returns {{ tense: string, explain: string }|null}
 */
function detectAdvancedTense(word, sentence) {
  const wordLower = word.toLowerCase();

  for (const tp of TENSE_PATTERNS) {
    const matches = [...sentence.matchAll(tp.regex)];
    for (const match of matches) {
      const targetGroup = match[tp.check];
      if (targetGroup && targetGroup.toLowerCase() === wordLower) {
        return { tense: tp.tense, explain: tp.explain };
      }
    }
  }
  return null;
}

/**
 * تحليل الكلمة نحوياً في سياق الجملة.
 */
export function explainGrammar(word, sentence) {
  const doc = nlp(sentence);
  const terms = doc.termList();
  const lower = word.toLowerCase();

  let targetTerm = null;
  for (const term of terms) {
    if ((term.text || '').toLowerCase() === lower) {
      targetTerm = term;
      break;
    }
  }

  // 1. Extract grammar role from compromise.js tags
  let grammarResult = { role: 'كلمة', why: 'جزء من الجملة.' };

  if (targetTerm) {
    const tags = targetTerm.tags || new Set();
    const priorityOrder = [
      'Contraction', 'Abbreviation', 'Expression',
      'PastTense', 'PresentTense', 'FutureTense', 'Gerund', 'Infinitive',
      'Participle', 'Modal', 'Auxiliary',
      'Superlative', 'Comparative', 'Adjective',
      'Adverb',
      'ProperNoun', 'Possessive', 'Uncountable', 'Plural', 'Singular',
      'QuestionWord', 'Negative', 'Conjunction', 'Preposition',
      'Determiner', 'Pronoun',
      'Verb', 'Noun',
    ];

    for (const tag of priorityOrder) {
      if (tags.has(tag) && GRAMMAR_RULES[tag]) {
        grammarResult = GRAMMAR_RULES[tag];
        break;
      }
    }
  }

  // 2. Check contextual patterns
  let contextHint = null;
  for (const cp of CONTEXT_PATTERNS) {
    const matches = [...sentence.matchAll(cp.pattern)];
    for (const match of matches) {
      if (cp.check(word, match)) {
        contextHint = cp.hint;
        break;
      }
    }
    if (contextHint) break;
  }

  // 3. Detect phrasal verbs / idioms
  const phrasalOrIdiom = detectPhrasalOrIdiom(word, sentence);

  // 4. Detect advanced tenses
  const advancedTense = detectAdvancedTense(word, sentence);

  return {
    role: grammarResult.role,
    why: grammarResult.why,
    contextHint,
    phrasalOrIdiom,
    advancedTense,
  };
}

/**
 * تحليل الكلمة صوتياً لاكتشاف الأحرف الصامتة وقواعد النطق.
 */
export function explainPhonetics(word) {
  const silentLetters = [];
  const tips = [];

  // Check silent letter rules
  for (const rule of SILENT_LETTER_RULES) {
    if (rule.regex.test(word)) {
      silentLetters.push({ letter: rule.letter, hint: rule.hint });
    }
  }

  // Check pronunciation tips (max 3 to keep it concise)
  let tipCount = 0;
  for (const rule of PRONUNCIATION_TIPS) {
    if (tipCount >= 3) break;
    if (rule.regex.test(word)) {
      tips.push(rule.hint);
      tipCount++;
    }
  }

  // Check final S pronunciation — v2
  const finalSHint = explainFinalS(word);
  if (finalSHint) {
    tips.push(finalSHint);
  }

  return { silentLetters, tips };
}

/**
 * الدالة الرئيسية — تجمع كل التحليلات وتنسقها كنص عربي مختصر.
 */
export function generateExplanation(word, sentence) {
  const grammar = explainGrammar(word, sentence);
  const phonetics = explainPhonetics(word);

  const parts = [];

  // ─── قسم التعبيرات الاصطلاحية / الأفعال المركبة (أولوية عليا) ───
  if (grammar.phrasalOrIdiom) {
    const poi = grammar.phrasalOrIdiom;
    const icon = poi.type === 'idiom' ? '🎭' : '🔗';
    const title = poi.type === 'idiom' ? 'تعبير اصطلاحي' : 'فعل مركب (Phrasal Verb)';
    parts.push(`<div class="mrky-explain-section">`);
    parts.push(`<div class="mrky-explain-title">${icon} ${title}</div>`);
    parts.push(`<div class="mrky-explain-role"><strong>"${poi.phrase}"</strong></div>`);
    parts.push(`<div class="mrky-explain-context">${poi.meaning}</div>`);
    parts.push(`</div>`);
  }

  // ─── القسم النحوي ───
  parts.push(`<div class="mrky-explain-section">`);
  parts.push(`<div class="mrky-explain-title">📝 التحليل النحوي</div>`);
  parts.push(`<div class="mrky-explain-role"><strong>${grammar.role}</strong> — ${grammar.why}</div>`);
  if (grammar.contextHint) {
    parts.push(`<div class="mrky-explain-context">💡 ${grammar.contextHint}</div>`);
  }
  parts.push(`</div>`);

  // ─── قسم الزمن المتقدم (إن وُجد) ───
  if (grammar.advancedTense) {
    parts.push(`<div class="mrky-explain-section">`);
    parts.push(`<div class="mrky-explain-title">⏱️ تحليل الزمن</div>`);
    parts.push(`<div class="mrky-explain-role"><strong>${grammar.advancedTense.tense}</strong></div>`);
    parts.push(`<div class="mrky-explain-context">${grammar.advancedTense.explain}</div>`);
    parts.push(`</div>`);
  }

  // ─── القسم الصوتي ───
  const hasPhonetics = phonetics.silentLetters.length > 0 || phonetics.tips.length > 0;
  if (hasPhonetics) {
    parts.push(`<div class="mrky-explain-section">`);
    parts.push(`<div class="mrky-explain-title">🔊 ملاحظات النطق</div>`);

    for (const sl of phonetics.silentLetters) {
      parts.push(`<div class="mrky-explain-silent">🔇 <strong>${sl.letter}</strong>: ${sl.hint}</div>`);
    }
    for (const tip of phonetics.tips) {
      parts.push(`<div class="mrky-explain-tip">✦ ${tip}</div>`);
    }

    parts.push(`</div>`);
  }

  return parts.join('');
}

/**
 * ذكاء اصطناعي محلي (Built-in Gemini Nano): يولد شرحاً تفاعلياً ذكياً ومخصصاً للسياق
 * بالاعتماد على Prompt API في متصفح كروم، مع العودة التلقائية للتعليل المحلي إذا لم يكن مدعوماً.
 *
 * Compatibility:
 *   - Chrome 148+: global `LanguageModel` namespace
 *   - Chrome 138–147: `window.ai.languageModel` namespace
 *   - availability() returns 'available' (modern) or 'readily' (legacy)
 *
 * @param {string} word
 * @param {string} sentence
 * @returns {Promise<string>}
 */
export async function getSmartExplanation(word, sentence) {
  try {
    // ── 1. Resolve API namespace (modern → legacy) ──
    const lm =
      (typeof LanguageModel !== 'undefined' ? LanguageModel : null) ||
      (typeof ai !== 'undefined' ? ai?.languageModel : null) ||
      (typeof window !== 'undefined' ? window.ai?.languageModel : null);

    if (!lm || typeof lm.availability !== 'function') {
      return generateExplanation(word, sentence);
    }

    // ── 2. Check availability ──
    const status = await lm.availability();
    // 'available' (Chrome 148+) or 'readily' (Chrome 138–147)
    if (status !== 'available' && status !== 'readily') {
      return generateExplanation(word, sentence);
    }

    // ── 3. Create session with system prompt ──
    const session = await lm.create({
      systemPrompt:
        'أنت معلم لغة إنجليزية خبير للمتحدثين بالعربية. اشرح الدور النحوي والسياق بإيجاز ووضوح بالعربية.',
    });

    // ── 4. Build prompt ──
    const prompt = `حلل كلمة "${word}" في هذه الجملة: "${sentence}".
اشرح دورها النحوي، صيغتها، ومعناها بالعربية.
أخرج HTML خام فقط بدون أي أكواد markdown. استخدم هذه الفئات:
- <div class="mrky-explain-section"> للأقسام
- <div class="mrky-explain-title"> ✨ عنوان القسم </div> للعناوين
- <div class="mrky-explain-role"> الدور النحوي أو الشرح </div>
- <div class="mrky-explain-context"> مثال أو ملاحظة </div>
اجعل الإجابة أقل من 3 أقسام قصيرة.`;

    // ── 5. Execute with timeout (8s) ──
    const result = await Promise.race([
      session.prompt(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI_TIMEOUT')), 8000)
      ),
    ]);

    session.destroy();

    if (result && typeof result === 'string' && result.trim()) {
      let cleanHtml = result.trim();
      // Strip accidental markdown fences
      if (cleanHtml.startsWith('```html')) cleanHtml = cleanHtml.substring(7);
      else if (cleanHtml.startsWith('```')) cleanHtml = cleanHtml.substring(3);
      if (cleanHtml.endsWith('```'))
        cleanHtml = cleanHtml.substring(0, cleanHtml.length - 3);
      return cleanHtml.trim();
    }
  } catch (err) {
    console.warn(
      '[PANDA AI] Local Gemini Nano unavailable or timed out, using rule-based engine:',
      err.message || err
    );
  }

  // Fallback to rule-based engine
  return generateExplanation(word, sentence);
}
