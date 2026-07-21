import nlp from 'compromise';
const doc = nlp("Mr. Smith went to Washington e.g. yesterday.");
const terms = doc.termList();
console.log(terms.map(t => ({ text: t.text, pre: t.pre, post: t.post })));
