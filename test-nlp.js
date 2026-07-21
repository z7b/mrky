import nlp from 'compromise';

const doc = nlp("We'll see if it works! What about words with apostrophes like 'cause?");
const terms = doc.termList();
console.log(terms.map(t => ({
  text: t.text,
  pre: t.pre,
  post: t.post,
})));
