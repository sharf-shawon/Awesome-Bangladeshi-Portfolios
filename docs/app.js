async function init(){
  const resp = await fetch('./data/portfolios.json');
  const data = await resp.json();

  function normalizeExternalUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return trimmed;
    return `https://${trimmed.replace(/^\/+/, '')}`;
  }

  // augment preview image via GitHub OpenGraph asset
  data.forEach(d=>{ d.preview = `https://opengraph.githubassets.com/1/${d.username}/${d.repoName || d.username}` });

  const fuse = new Fuse(data, {
    keys: ['username','description','topics','top_language','all_languages'],
    threshold: 0.3
  });

  const q = document.getElementById('q');
  const results = document.getElementById('results');
  const tmpl = document.getElementById('card-tmpl');
  const languageFilter = document.getElementById('languageFilter');
  const sortSelect = document.getElementById('sortSelect');

  // populate language filter
  const langs = Array.from(new Set(data.flatMap(d=>d.all_languages||[]))).filter(Boolean).sort();
  langs.forEach(l=>{
    const o=document.createElement('option');o.value=l;o.textContent=l;languageFilter.appendChild(o);
  });

  function render(list){
    results.innerHTML='';
    list.forEach(item=>{
      const el = tmpl.content.cloneNode(true);
      const card = el.querySelector('.card');
      const openRepo = () => window.open(item.repoUrl, '_blank', 'noopener');
      card.tabIndex = 0;
      card.setAttribute('role', 'link');
      card.addEventListener('click', openRepo);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openRepo();
        }
      });

      el.querySelector('.og').src = item.preview;
      el.querySelector('.username').textContent = item.username;
      el.querySelector('.desc').textContent = item.description || '';
      const badges = el.querySelector('.badges');
      if(item.top_language) { const b=document.createElement('span'); b.className='badge'; b.textContent=item.top_language; badges.appendChild(b); }
      (item.topics||[]).slice(0,6).forEach(t=>{ const b=document.createElement('span'); b.className='badge'; b.textContent=t; badges.appendChild(b); });
      el.querySelector('.stars').textContent = item.stars||0;
      el.querySelector('.forks').textContent = item.forks||0;
      const repoLink = el.querySelector('.repo');
      const profileLink = el.querySelector('.profile');
      const websiteLink = el.querySelector('.website');
      repoLink.href = item.repoUrl;
      profileLink.href = item.profile_url || `https://github.com/${item.username}`;
      const websiteUrl = normalizeExternalUrl(item.website_url);
      if (websiteUrl) {
        if (websiteLink) {
          websiteLink.href = websiteUrl;
          websiteLink.hidden = false;
        }
      } else {
        if (websiteLink) {
          websiteLink.remove();
        }
      }

      [repoLink, profileLink, websiteLink].filter(Boolean).forEach(link => {
        link.addEventListener('click', (event) => event.stopPropagation());
      });
      results.appendChild(el);
    });
  }

  function applyFiltersAndRender(){
    let list = data.slice();
    const qv = q.value.trim();
    if(qv) list = fuse.search(qv).map(r=>r.item);
    const lang = languageFilter.value;
    if(lang) list = list.filter(d=> (d.all_languages||[]).includes(lang));
    const sort = sortSelect.value;
    if(sort==='stars_desc') list.sort((a,b)=> (b.stars||0)-(a.stars||0));
    if(sort==='stars_asc') list.sort((a,b)=> (a.stars||0)-(b.stars||0));
    if(sort==='forks_desc') list.sort((a,b)=> (b.forks||0)-(a.forks||0));
    if(sort==='forks_asc') list.sort((a,b)=> (a.forks||0)-(b.forks||0));
    if(sort==='name') list.sort((a,b)=> a.username.localeCompare(b.username));
    render(list);
  }

  q.addEventListener('input', ()=>applyFiltersAndRender());
  languageFilter.addEventListener('change', ()=>applyFiltersAndRender());
  sortSelect.addEventListener('change', ()=>applyFiltersAndRender());

  sortSelect.value = 'stars_desc';
  applyFiltersAndRender();
}

init().catch(err=>{console.error(err);document.body.innerHTML='<p style="color:#f88;padding:24px">Failed to load data.</p>'});
