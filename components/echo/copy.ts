import { normalizeLang } from '@/lib/langs';

/**
 * Every word the echo wall says to a visitor, in the visitor's own language.
 *
 * This file is imported by client components, so it must stay pure data — no
 * lib/sarvam, no lib/db, nothing server-only. lib/langs is safe: it is a table
 * and three pure functions.
 *
 * The consent line is the one piece of copy in this product that has to be right.
 * It is written the way a person would say it out loud, not the way a lawyer would
 * write it: what happens to the recording, who checks it, and what is never shown.
 * It is never pre-ticked and never implied by pressing "send".
 */

export interface EchoCopy {
  invite: string;
  inviteHint: string;
  limitNote: string;
  start: string;
  stop: string;
  again: string;
  recording: string;
  ready: string;
  cityLabel: string;
  cityPlaceholder: string;
  consent: string;
  consentRequired: string;
  send: string;
  sending: string;
  thanks: string;
  pending: string;
  cancel: string;
  micDenied: string;
  micUnsupported: string;
  notConfigured: string;
  failed: string;
  retry: string;
  /** e.g. "12s left" */
  remaining: (seconds: number) => string;
}

const EN: EchoCopy = {
  invite: 'Leave a memory',
  inviteHint: 'Tell me something you remember here. The next visitor will hear it.',
  limitNote: 'Up to 30 seconds.',
  start: 'Speak',
  stop: 'Stop',
  again: 'Record again',
  recording: 'Listening…',
  ready: 'Ready to send',
  cityLabel: 'Which city are you from?',
  cityPlaceholder: 'Optional',
  consent:
    'Yes — keep my voice and let other visitors hear it. A person will check it first. My name is never shown; only my language, my city and the month.',
  consentRequired: 'Tick the box above and I will keep it.',
  send: 'Give it to the monument',
  sending: 'Sending…',
  thanks: 'Thank you. I will remember this.',
  pending: 'A person reads every memory before anyone else hears it.',
  cancel: 'Not now',
  micDenied: 'I cannot reach your microphone. Allow it in your browser and try again.',
  micUnsupported: 'This browser will not let me record. Try Chrome on Android.',
  notConfigured:
    'My ears are not connected yet — the speech service has no key on this device, so I cannot understand a recording. Nothing is stored.',
  failed: 'Something went wrong and nothing was stored.',
  retry: 'Try again',
  remaining: (s) => `${s}s left`,
};

export const ECHO_COPY: Record<string, EchoCopy> = {
  'en-IN': EN,

  'hi-IN': {
    invite: 'एक याद छोड़ जाइए',
    inviteHint: 'यहाँ की कोई बात सुनाइए जो आपको याद है। अगला यात्री उसे सुनेगा।',
    limitNote: 'तीस सेकंड तक।',
    start: 'बोलिए',
    stop: 'रोकिए',
    again: 'फिर से रिकॉर्ड करें',
    recording: 'सुन रहा हूँ…',
    ready: 'भेजने के लिए तैयार',
    cityLabel: 'आप किस शहर से हैं?',
    cityPlaceholder: 'बताना ज़रूरी नहीं',
    consent:
      'हाँ — मेरी आवाज़ सहेजिए और दूसरे यात्रियों को सुनाइए। पहले कोई इंसान इसे जाँचेगा। मेरा नाम कभी नहीं दिखेगा — सिर्फ़ मेरी भाषा, मेरा शहर और महीना।',
    consentRequired: 'ऊपर वाला डिब्बा चुनिए, तभी मैं इसे सहेजूँगा।',
    send: 'मीनार को दे दीजिए',
    sending: 'भेजा जा रहा है…',
    thanks: 'शुक्रिया। यह मुझे याद रहेगा।',
    pending: 'हर याद को कोई इंसान पढ़ता है, तभी कोई और उसे सुनता है।',
    cancel: 'अभी नहीं',
    micDenied: 'माइक्रोफ़ोन तक नहीं पहुँच पा रहा। ब्राउज़र में इजाज़त दीजिए और फिर कोशिश कीजिए।',
    micUnsupported: 'यह ब्राउज़र रिकॉर्ड नहीं करने देता। एंड्रॉइड पर क्रोम आज़माइए।',
    notConfigured:
      'मेरे कान अभी जुड़े नहीं हैं — इस डिवाइस पर आवाज़ पहचानने की चाबी नहीं है, इसलिए मैं रिकॉर्डिंग समझ नहीं सकता। कुछ भी सहेजा नहीं गया।',
    failed: 'कुछ गड़बड़ हुई और कुछ भी सहेजा नहीं गया।',
    retry: 'फिर कोशिश कीजिए',
    remaining: (s) => `${s} सेकंड बाकी`,
  },

  'ta-IN': {
    invite: 'ஒரு நினைவை விட்டுச் செல்லுங்கள்',
    inviteHint: 'இங்கே உங்களுக்கு நினைவிருப்பதைச் சொல்லுங்கள். அடுத்த பயணி அதைக் கேட்பார்.',
    limitNote: 'முப்பது வினாடிகள் வரை.',
    start: 'பேசுங்கள்',
    stop: 'நிறுத்துங்கள்',
    again: 'மீண்டும் பதிவு செய்யுங்கள்',
    recording: 'கேட்டுக் கொண்டிருக்கிறேன்…',
    ready: 'அனுப்பத் தயார்',
    cityLabel: 'நீங்கள் எந்த ஊரிலிருந்து வருகிறீர்கள்?',
    cityPlaceholder: 'சொல்ல வேண்டியதில்லை',
    consent:
      'ஆம் — என் குரலைச் சேமித்து, மற்ற பயணிகள் கேட்க அனுமதிக்கிறேன். முதலில் ஒரு மனிதர் இதைச் சரிபார்ப்பார். என் பெயர் ஒருபோதும் காட்டப்படாது — என் மொழி, என் ஊர், மாதம் மட்டுமே.',
    consentRequired: 'மேலே உள்ள பெட்டியைத் தேர்ந்தெடுத்தால் மட்டுமே நான் இதைச் சேமிப்பேன்.',
    send: 'மினாரிடம் கொடுங்கள்',
    sending: 'அனுப்பப்படுகிறது…',
    thanks: 'நன்றி. இதை நான் நினைவில் வைத்திருப்பேன்.',
    pending: 'ஒவ்வொரு நினைவையும் ஒரு மனிதர் படித்த பிறகே மற்றவர்கள் கேட்பார்கள்.',
    cancel: 'இப்போது வேண்டாம்',
    micDenied: 'உங்கள் ஒலிவாங்கியை அணுக முடியவில்லை. உலாவியில் அனுமதி கொடுத்து மீண்டும் முயலுங்கள்.',
    micUnsupported: 'இந்த உலாவி பதிவு செய்ய அனுமதிக்கவில்லை. ஆண்ட்ராய்டில் Chrome முயலுங்கள்.',
    notConfigured:
      'என் காதுகள் இன்னும் இணைக்கப்படவில்லை — இந்தச் சாதனத்தில் பேச்சு அறியும் திறவுகோல் இல்லை, எனவே பதிவை என்னால் புரிந்துகொள்ள முடியாது. எதுவும் சேமிக்கப்படவில்லை.',
    failed: 'ஏதோ தவறாகிவிட்டது; எதுவும் சேமிக்கப்படவில்லை.',
    retry: 'மீண்டும் முயலுங்கள்',
    remaining: (s) => `${s} வினாடி மீதம்`,
  },

  'bn-IN': {
    invite: 'একটি স্মৃতি রেখে যান',
    inviteHint: 'এখানকার যা আপনার মনে আছে, বলুন। পরের দর্শনার্থী সেটি শুনবেন।',
    limitNote: 'তিরিশ সেকেন্ড পর্যন্ত।',
    start: 'বলুন',
    stop: 'থামুন',
    again: 'আবার রেকর্ড করুন',
    recording: 'শুনছি…',
    ready: 'পাঠানোর জন্য প্রস্তুত',
    cityLabel: 'আপনি কোন শহর থেকে এসেছেন?',
    cityPlaceholder: 'বলা বাধ্যতামূলক নয়',
    consent:
      'হ্যাঁ — আমার কণ্ঠস্বর রেখে দিন এবং অন্য দর্শনার্থীদের শোনান। আগে একজন মানুষ এটি দেখে নেবেন। আমার নাম কখনও দেখানো হবে না — শুধু আমার ভাষা, আমার শহর আর মাস।',
    consentRequired: 'উপরের ঘরটিতে টিক দিলে তবেই আমি এটি রাখব।',
    send: 'মিনারকে দিন',
    sending: 'পাঠানো হচ্ছে…',
    thanks: 'ধন্যবাদ। এটি আমার মনে থাকবে।',
    pending: 'প্রতিটি স্মৃতি একজন মানুষ পড়ে দেখেন, তার পরেই অন্য কেউ শোনেন।',
    cancel: 'এখন নয়',
    micDenied: 'আপনার মাইক্রোফোনে পৌঁছাতে পারছি না। ব্রাউজারে অনুমতি দিয়ে আবার চেষ্টা করুন।',
    micUnsupported: 'এই ব্রাউজার রেকর্ড করতে দেয় না। অ্যান্ড্রয়েডে Chrome ব্যবহার করুন।',
    notConfigured:
      'আমার কান এখনও যুক্ত হয়নি — এই যন্ত্রে কথা বোঝার চাবি নেই, তাই রেকর্ডিং আমি বুঝতে পারব না। কিছুই সংরক্ষণ করা হয়নি।',
    failed: 'কিছু একটা ভুল হয়েছে, কিছুই সংরক্ষণ করা হয়নি।',
    retry: 'আবার চেষ্টা করুন',
    remaining: (s) => `${s} সেকেন্ড বাকি`,
  },

  'te-IN': {
    invite: 'ఒక జ్ఞాపకాన్ని వదిలి వెళ్లండి',
    inviteHint: 'ఇక్కడ మీకు గుర్తున్నది చెప్పండి. తరువాతి సందర్శకుడు దాన్ని వింటారు.',
    limitNote: 'ముప్పై సెకన్ల వరకు.',
    start: 'మాట్లాడండి',
    stop: 'ఆపండి',
    again: 'మళ్లీ రికార్డ్ చేయండి',
    recording: 'వింటున్నాను…',
    ready: 'పంపడానికి సిద్ధం',
    cityLabel: 'మీరు ఏ ఊరి నుంచి వచ్చారు?',
    cityPlaceholder: 'చెప్పాల్సిన అవసరం లేదు',
    consent:
      'అవును — నా గొంతును భద్రపరచండి, ఇతర సందర్శకులకు వినిపించండి. ముందుగా ఒక వ్యక్తి దీన్ని పరిశీలిస్తారు. నా పేరు ఎప్పుడూ కనిపించదు — నా భాష, నా ఊరు, నెల మాత్రమే.',
    consentRequired: 'పైన ఉన్న పెట్టెను ఎంచుకుంటేనే నేను దీన్ని ఉంచుతాను.',
    send: 'మినార్‌కు ఇవ్వండి',
    sending: 'పంపుతున్నాను…',
    thanks: 'ధన్యవాదాలు. ఇది నాకు గుర్తుంటుంది.',
    pending: 'ప్రతి జ్ఞాపకాన్ని ఒక వ్యక్తి చదివాకే మరొకరు వింటారు.',
    cancel: 'ఇప్పుడు కాదు',
    micDenied: 'మీ మైక్రోఫోన్‌ను అందుకోలేకపోతున్నాను. బ్రౌజర్‌లో అనుమతి ఇచ్చి మళ్లీ ప్రయత్నించండి.',
    micUnsupported: 'ఈ బ్రౌజర్ రికార్డ్ చేయనివ్వదు. ఆండ్రాయిడ్‌లో Chrome ప్రయత్నించండి.',
    notConfigured:
      'నా చెవులు ఇంకా కలపబడలేదు — ఈ పరికరంలో మాట గుర్తించే కీ లేదు, కాబట్టి రికార్డింగ్ నాకు అర్థం కాదు. ఏమీ భద్రపరచలేదు.',
    failed: 'ఏదో పొరపాటు జరిగింది, ఏమీ భద్రపరచలేదు.',
    retry: 'మళ్లీ ప్రయత్నించండి',
    remaining: (s) => `${s} సెకన్లు మిగిలాయి`,
  },

  'mr-IN': {
    invite: 'एक आठवण ठेवून जा',
    inviteHint: 'इथली तुम्हाला आठवणारी गोष्ट सांगा. पुढचा प्रवासी ती ऐकेल.',
    limitNote: 'तीस सेकंदांपर्यंत.',
    start: 'बोला',
    stop: 'थांबा',
    again: 'पुन्हा रेकॉर्ड करा',
    recording: 'ऐकतो आहे…',
    ready: 'पाठवायला तयार',
    cityLabel: 'तुम्ही कोणत्या शहरातून आलात?',
    cityPlaceholder: 'सांगणे बंधनकारक नाही',
    consent:
      'होय — माझा आवाज जपून ठेवा आणि इतर प्रवाशांना ऐकवा. आधी एक माणूस तो तपासेल. माझे नाव कधीही दाखवले जाणार नाही — फक्त माझी भाषा, माझे शहर आणि महिना.',
    consentRequired: 'वरची खूण केलीत तरच मी ही आठवण ठेवीन.',
    send: 'मिनारला द्या',
    sending: 'पाठवत आहे…',
    thanks: 'धन्यवाद. हे मला लक्षात राहील.',
    pending: 'प्रत्येक आठवण एक माणूस वाचतो, मगच ती दुसऱ्याला ऐकू येते.',
    cancel: 'आत्ता नको',
    micDenied: 'तुमच्या मायक्रोफोनपर्यंत पोहोचता येत नाही. ब्राउझरमध्ये परवानगी द्या आणि पुन्हा प्रयत्न करा.',
    micUnsupported: 'हा ब्राउझर रेकॉर्ड करू देत नाही. अँड्रॉइडवर Chrome वापरून पहा.',
    notConfigured:
      'माझे कान अजून जोडलेले नाहीत — या उपकरणावर बोलणे ओळखण्याची किल्ली नाही, त्यामुळे रेकॉर्डिंग मला समजणार नाही. काहीही साठवले गेलेले नाही.',
    failed: 'काहीतरी चुकले आणि काहीही साठवले गेले नाही.',
    retry: 'पुन्हा प्रयत्न करा',
    remaining: (s) => `${s} सेकंद बाकी`,
  },
};

/** Falls back through the language's voice relative, then English. Never throws. */
export function echoCopy(lang: string | null | undefined): EchoCopy {
  const code = normalizeLang(lang);
  if (ECHO_COPY[code]) return ECHO_COPY[code];
  const base = code.split('-')[0];
  const byBase = Object.keys(ECHO_COPY).find((k) => k.split('-')[0] === base);
  return byBase ? ECHO_COPY[byBase] : EN;
}

/** True when we have hand-written copy for this language rather than English. */
export function hasNativeCopy(lang: string | null | undefined): boolean {
  return Boolean(ECHO_COPY[normalizeLang(lang)]);
}
