(async () => {
  const res = await fetch('https://en.wikipedia.org/wiki/Main_Page');
  const html = await res.text();
  const index = html.indexOf('Recently featured');
  if (index !== -1) {
    console.log(html.substring(index - 300, index + 300));
  } else {
    console.log('Not found');
  }
})();
