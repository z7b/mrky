/**
 * PANDA🐼 World-Class Email Validation, Anti-Disposable & Typo Detection Engine
 * Adheres to RFC 5322 Standards + Disposable Email Blacklisting + International UX Best Practices
 */

// Comprehensive Anti-Disposable / Temporary Email Domains Blacklist (Mohmal, TempMail, 10MinuteMail, etc.)
const DISPOSABLE_DOMAINS = new Set([
  // Mohmal (مهمل)
  'mohmal.com', 'mohmal.in', 'mohmal.tech', 'mohmal.net', 'mohmal.im',
  // Temp Mail & 10 Minute Mail
  'tempmail.com', 'tempmail.net', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com',
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minutemail.co.uk',
  // Guerrilla Mail & Sharklasers
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'sharklasers.com',
  // Yopmail & Mailinator
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'mailinator.com', 'mailinator2.com',
  // Trashmail & Dispostable
  'trashmail.com', 'trashmail.net', 'trashmail.me', 'trashmail.io', 'dispostable.com',
  // FakeMail & Generators
  'fakemailgenerator.com', 'fakemail.net', 'generator.email', 'fake-email.com',
  // GetNada & Nada
  'nada.ltd', 'getnada.com', 'abmail.store',
  // Throwaway & Burner
  'throwawaymail.com', 'burnermail.io', 'burner.com', 'emailondeck.com',
  // Maildrop, InboxKitten, Airmail, Tempail
  'maildrop.cc', 'inboxkitten.com', 'getairmail.com', 'tempail.com', 'crazymailing.com',
  'disposablemail.com', 'mailnesia.com', 'mytemp.email', 'tempmail.dev'
]);

// Common email domain typos dictionary for smart auto-suggestion
const DOMAIN_TYPOS = {
  'gemil.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gamil.co': 'gmail.com',
  'gamel.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'yaho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'iclod.com': 'icloud.com',
  'icould.com': 'icloud.com',
};

/**
 * Validates an email address according to RFC 5322, anti-disposable rules, and UX standards.
 * @param {string} email 
 * @returns {{ valid: boolean, error?: string, suggestion?: string, cleanEmail?: string, warning?: string }}
 */
export function validateEmail(email) {
  if (!email || !email.trim()) {
    return { valid: false, error: 'الرجاء إدخال البريد الإلكتروني' };
  }

  const raw = email.trim();

  // 1. Non-ASCII / Arabic character check
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(raw)) {
    return { 
      valid: false, 
      error: 'البريد الإلكتروني يجب أن يكتب بالحروف والرموز الإنجليزية فقط (بدون حروف عربية)' 
    };
  }

  // 2. Check for missing or multiple '@'
  const atCount = (raw.match(/@/g) || []).length;
  if (atCount === 0) {
    return { valid: false, error: 'البريد الإلكتروني مفقود منه رمز @ (مثال: user@example.com)' };
  }
  if (atCount > 1) {
    return { valid: false, error: 'البريد يحتوي على أكثر من رمز @' };
  }

  // 3. Split into local part and domain part
  const parts = raw.split('@');
  const localPart = parts[0];
  const domainPart = parts[1];

  if (!localPart) {
    return { valid: false, error: 'البريد مفقود منه اسم المستخدم قبل رمز @' };
  }
  if (!domainPart) {
    return { valid: false, error: 'البريد مفقود منه اسم النطاق بعد رمز @ (مثال: gmail.com)' };
  }

  // 4. Illegal characters check in local part & domain (RFC 5322)
  const illegalCharMatch = raw.match(/[#$%\^&\*\(\)=\+<>\,\/\\\|\~\`\"\:;\{\}\[\]\s]/);
  if (illegalCharMatch) {
    return { 
      valid: false, 
      error: `البريد يحتوي على رمز غير مسموح به برمجياً (${illegalCharMatch[0]})` 
    };
  }

  // 5. Consecutive dots or starting/ending dot check
  if (/\.\./.test(raw) || localPart.startsWith('.') || localPart.endsWith('.') || domainPart.startsWith('.') || domainPart.endsWith('.')) {
    return { valid: false, error: 'البريد يحتوي على نقاط متتالية أو يبدأ/ينتهي بنقطة خاطئة' };
  }

  // 6. Domain structure & TLD validation
  const domainParts = domainPart.split('.');
  if (domainParts.length < 2) {
    return { valid: false, error: 'اسم النطاق غير مكتمل (يجب أن ينتهي بـ .com أو .net أو غيرها)' };
  }

  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-zA-Z]{2,10}$/.test(tld)) {
    return { valid: false, error: `امتداد النطاق (.${tld}) غير صحيح` };
  }

  const domainLower = domainPart.toLowerCase();

  // 7. 🛡️ Anti-Disposable / Temporary Email Detection Engine (Mohmal, TempMail, etc.)
  if (DISPOSABLE_DOMAINS.has(domainLower)) {
    return {
      valid: false,
      error: '⛔ يرجى استخدام بريد إلكتروني حقيقي ودائم (مثل Gmail, Outlook, Yahoo). الإيميلات المؤقتة (مثل مهمل أو TempMail) غير مسموح بها لحماية حسابك واشتراكك.'
    };
  }

  const cleanEmail = raw.toLowerCase();

  // 8. Typo Suggestion Engine (e.g. gemil.com -> gmail.com)
  let suggestion = null;
  if (DOMAIN_TYPOS[domainLower]) {
    const correctedDomain = DOMAIN_TYPOS[domainLower];
    suggestion = `${localPart}@${correctedDomain}`;
  }

  return {
    valid: true,
    cleanEmail,
    suggestion,
    warning: suggestion ? `💡 هل تقصد: ${suggestion}؟` : null
  };
}

/**
 * Validates password strength according to security standards.
 * @param {string} password 
 * @param {boolean} [isSignUp=false]
 * @returns {{ valid: boolean, error?: string, warning?: string }}
 */
export function validatePassword(password, isSignUp = false) {
  if (!password) {
    return { valid: false, error: 'الرجاء إدخال كلمة المرور' };
  }
  const clean = password.trim();
  if (clean.length < 6) {
    return { valid: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' };
  }

  if (isSignUp && clean.length < 8) {
    return { valid: true, warning: 'توصية: يفضل أن تكون كلمة المرور 8 أحرف أو أكثر لأمان أفضل' };
  }

  return { valid: true };
}
