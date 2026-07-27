const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modalContent');
const state = JSON.parse(localStorage.getItem('mealState') || '{}');
state.favorites ??= [];
state.ratings ??= {};
state.plan ??= {};
state.shopping ??= {};
state.recipeIngredients ??= {};
state.view ??= 'today';
const save=()=>localStorage.setItem('mealState',JSON.stringify(state));
const target={kcal:1750,protein:130,fat:60,carbs:165};
const days=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
const slots=[['breakfast','Завтрак'],['lunch','Обед'],['snack','Перекус'],['dinner','Ужин']];
function dish(id){return DISHES.find(d=>d.id===id)}
function totals(ids){return ids.map(dish).filter(Boolean).reduce((a,d)=>({kcal:a.kcal+d.kcal,protein:a.protein+d.protein,fat:a.fat+d.fat,carbs:a.carbs+d.carbs}),{kcal:0,protein:0,fat:0,carbs:0})}
function macro(t,label,key){const pct=Math.min(100,Math.round((t[key]/target[key])*100));return `<div class="macro"><b>${Math.round(t[key])}</b><span>${label}</span></div>`}
function currentDay(){return days[(new Date().getDay()+6)%7]}
function renderToday(){const day=currentDay(), p=state.plan[day]||{}, ids=slots.map(([k])=>p[k]).filter(Boolean), t=totals(ids); app.innerHTML=`<section class="hero"><span class="eyebrow">${day}</span><h2>${t.kcal} / ${target.kcal} ккал</h2><div class="macro-grid">${macro(t,'ккал','kcal')}${macro(t,'белок','protein')}${macro(t,'жиры','fat')}${macro(t,'углеводы','carbs')}</div><div class="progress"><i style="width:${Math.min(100,t.kcal/target.kcal*100)}%"></i></div></section><section class="section"><h2>Сегодня</h2>${slots.map(([k,l])=>{const d=dish(p[k]);return `<div class="card dish-card" onclick="chooseMeal('${day}','${k}')"><div><div class="dish-id">${l}</div><div class="dish-title">${d?d.name:'Выбрать блюдо'}</div><div class="meta">${d?`${d.kcal} ккал · Б ${d.protein} · Ж ${d.fat} · У ${d.carbs}`:'Нажмите, чтобы добавить'}</div></div><div>${d?'›':'＋'}</div></div>`}).join('')}</section><section class="section"><button class="btn" onclick="randomizeDay('${day}')">Собрать день автоматически</button></section>`}
function renderLibrary(){app.innerHTML=`<input id="search" class="search" placeholder="Найти блюдо или ингредиент"><div class="chips" id="cats">${['Все','Завтрак','Основное','Перекус','Аварийное','❤️'].map((x,i)=>`<button class="chip ${i===0?'active':''}" data-cat="${x}">${x}</button>`).join('')}</div><div id="dishList"></div>`; let cat='Все'; const draw=()=>{const q=document.querySelector('#search').value.toLowerCase();const arr=DISHES.filter(d=>(cat==='Все'||d.category===cat||(cat==='❤️'&&state.favorites.includes(d.id)))&&(d.name+' '+d.ingredients.join(' ')+' '+d.tags.join(' ')).toLowerCase().includes(q)); document.querySelector('#dishList').innerHTML=arr.map(cardHTML).join('')||'<div class="empty">Ничего не найдено. Даже еда иногда умеет исчезать.</div>'}; document.querySelector('#search').oninput=draw; document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{cat=b.dataset.cat;document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('active',x===b));draw()});draw()}
function cardHTML(d){return `<div class="card dish-card" onclick="openDish('${d.id}')"><div><div class="dish-id">${d.id} · ${d.category}</div><div class="dish-title">${d.name}</div><div class="meta">${d.minutes} мин · Б ${d.protein} г · ${d.tags.slice(0,3).join(' · ')}</div></div><div><div class="kcal">${d.kcal}</div><div class="meta">ккал</div></div></div>`}
function defaultIngredientsFor(id){
  const d=dish(id), detail=RECIPE_DETAILS[id];
  if(detail?.ingredients){
    return detail.ingredients.map(line=>{
      const m=line.match(/^(.+?)\s+—\s+([\d.,]+)\s*([^\s]+)?$/);
      return m?{name:m[1].trim(),qty:Number(m[2].replace(',','.')),unit:m[3]||'г'}:{name:line,qty:'',unit:'г'};
    });
  }
  return d.ingredients.map(name=>({name,qty:'',unit:'г'}));
}
function recipeIngredients(id){return state.recipeIngredients[id] || defaultIngredientsFor(id)}
function ingredientText(x){return `${x.name}${x.qty!==''&&x.qty!=null?` — ${x.qty} ${x.unit||'г'}`:''}`}
function openDish(id){const d=dish(id), detail=RECIPE_DETAILS[id], ings=recipeIngredients(id); modalContent.innerHTML=`<span class="eyebrow">${d.id} · ${d.category}</span><h2 style="padding-right:44px">${d.name}</h2><div class="macro-grid">${[['ккал',d.kcal],['Б',d.protein],['Ж',d.fat],['У',d.carbs]].map(x=>`<div class="macro"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('')}</div><section class="section"><div class="day-head"><h3>Ингредиенты</h3><button class="chip" onclick="editIngredients('${id}')">✎ граммовки</button></div><ul class="ingredient-list">${ings.map(x=>`<li>${ingredientText(x)}</li>`).join('')}</ul></section><section class="section"><h3>Приготовление</h3><p class="note">${detail?.steps||'Подготовить компоненты и собрать блюдо. Граммовки можно внести кнопкой «✎ граммовки» прямо в карточке.'}</p></section><section class="section"><h3>Заготовка</h3><p class="note">${d.prep}. ${detail?.storage||''}</p></section>${detail?.replacements?`<section class="section"><h3>Замены</h3><p class="note">${detail.replacements}</p></section>`:''}<div class="row"><button class="btn" onclick="toggleFavorite('${id}')">${state.favorites.includes(id)?'♥ В любимых':'♡ В любимое'}</button><button class="btn" onclick="addToToday('${id}')">Добавить сегодня</button></div>`;modal.classList.remove('hidden')}
function editIngredients(id){
  const rows=recipeIngredients(id).map(x=>({...x}));
  const draw=()=>{modalContent.innerHTML=`<h2>Граммовки · ${dish(id).name}</h2><p class="note">Указывай количество на <b>1 порцию</b>. Для круп удобнее выбрать один стандарт: например, всегда вес готового продукта. Иначе список покупок быстро становится философским спором о сухом рисе.</p><div id="ingredientEditor">${rows.map((x,i)=>`<div class="ingredient-edit-row"><input value="${String(x.name).replace(/"/g,'&quot;')}" oninput="editIngField(${i},'name',this.value)"><input type="number" min="0" step="1" placeholder="г" value="${x.qty??''}" oninput="editIngField(${i},'qty',this.value)"><select onchange="editIngField(${i},'unit',this.value)">${['г','мл','шт','ст.л.','ч.л.','банка','уп.'].map(u=>`<option ${x.unit===u?'selected':''}>${u}</option>`).join('')}</select><button class="remove-ing" onclick="removeIng(${i})">×</button></div>`).join('')}</div><div class="week-actions"><button class="btn secondary" onclick="addIngredientRow()">＋ ингредиент</button><button class="btn" onclick="saveIngredients('${id}')">Сохранить</button></div>`;};
  window._editingIngredients=rows; window.editIngField=(i,k,v)=>{window._editingIngredients[i][k]=k==='qty'?(v===''?'':Number(v)):v}; window.removeIng=i=>{window._editingIngredients.splice(i,1);editIngredientsFromBuffer(id)}; window.addIngredientRow=()=>{window._editingIngredients.push({name:'',qty:'',unit:'г'});editIngredientsFromBuffer(id)}; window.saveIngredients=id2=>{state.recipeIngredients[id2]=window._editingIngredients.filter(x=>x.name.trim());save();openDish(id2)}; draw();
}
function editIngredientsFromBuffer(id){const keep=window._editingIngredients.map(x=>({...x})); editIngredients(id); window._editingIngredients=keep; const rows=keep; modalContent.querySelector('#ingredientEditor').innerHTML=rows.map((x,i)=>`<div class="ingredient-edit-row"><input value="${String(x.name).replace(/"/g,'&quot;')}" oninput="editIngField(${i},'name',this.value)"><input type="number" min="0" step="1" value="${x.qty??''}" oninput="editIngField(${i},'qty',this.value)"><select onchange="editIngField(${i},'unit',this.value)">${['г','мл','шт','ст.л.','ч.л.','банка','уп.'].map(u=>`<option ${x.unit===u?'selected':''}>${u}</option>`).join('')}</select><button class="remove-ing" onclick="removeIng(${i})">×</button></div>`).join('')}
function toggleFavorite(id){state.favorites=state.favorites.includes(id)?state.favorites.filter(x=>x!==id):[...state.favorites,id];save();openDish(id)}
function addToToday(id){const d=dish(id);const key=d.category==='Завтрак'?'breakfast':d.category==='Перекус'?'snack':'dinner';state.plan[currentDay()]??={};state.plan[currentDay()][key]=id;save();modal.classList.add('hidden');render()}
function renderWeek(){
  const weekTotals=days.map(day=>totals(slots.map(([k])=>(state.plan[day]||{})[k]).filter(Boolean)));
  const filled=weekTotals.filter(t=>t.kcal>0);
  const avg=filled.length?Math.round(filled.reduce((a,t)=>a+t.kcal,0)/filled.length):0;
  app.innerHTML=`<section><h2>Неделя</h2><div class="week-actions"><button class="btn" onclick="randomizeWeek()">Составить всю неделю</button><button class="btn secondary" onclick="clearWeek()">Очистить неделю</button></div>${filled.length?`<div class="week-summary">Среднее: <b>${avg} ккал/день</b> · заполнено ${filled.length}/7 дней</div>`:''}<p class="note">Автоплан старается держаться около ${target.kcal} ккал и ${target.protein} г белка в день и не повторять одно основное блюдо слишком часто.</p>${days.map(day=>{const p=state.plan[day]||{},t=totals(slots.map(([k])=>p[k]).filter(Boolean));return `<div class="day"><div class="day-head"><b>${day}</b><span class="meta">${t.kcal} ккал · Б ${t.protein}</span></div><div class="slots">${slots.map(([k,l])=>{const d=dish(p[k]);return `<div class="slot"><span>${l}: <b>${d?d.name:'не выбрано'}</b></span><button onclick="chooseMeal('${day}','${k}')">${d?'заменить':'+'}</button></div>`}).join('')}</div></div>`}).join('')}</section>`}
function clearWeek(){state.plan={};save();render()}
function chooseMeal(day,key){const desired=key==='breakfast'?'Завтрак':key==='snack'?'Перекус':'Основное';const arr=DISHES.filter(d=>d.category===desired || (key!=='breakfast'&&key!=='snack'&&d.category==='Аварийное'));modalContent.innerHTML=`<h2>Выбрать: ${slots.find(s=>s[0]===key)[1]}</h2><input class="search" id="pickerSearch" placeholder="Поиск"><div id="pickerList">${arr.map(d=>`<div class="card dish-card" onclick="setMeal('${day}','${key}','${d.id}')"><div><div class="dish-title">${d.name}</div><div class="meta">${d.kcal} ккал · Б ${d.protein}</div></div><div>＋</div></div>`).join('')}</div>`;modal.classList.remove('hidden');document.querySelector('#pickerSearch').oninput=e=>{const q=e.target.value.toLowerCase();document.querySelector('#pickerList').innerHTML=arr.filter(d=>(d.name+' '+d.ingredients.join(' ')).toLowerCase().includes(q)).map(d=>`<div class="card dish-card" onclick="setMeal('${day}','${key}','${d.id}')"><div><div class="dish-title">${d.name}</div><div class="meta">${d.kcal} ккал · Б ${d.protein}</div></div><div>＋</div></div>`).join('')}}
function setMeal(day,key,id){state.plan[day]??={};state.plan[day][key]=id;save();modal.classList.add('hidden');render()}
function randomizeDay(day){
  const b=DISHES.filter(d=>d.category==='Завтрак'),m=DISHES.filter(d=>d.category==='Основное'),sn=DISHES.filter(d=>d.category==='Перекус');
  let best=null,bestScore=Infinity;
  for(let i=0;i<500;i++){
    const plan={breakfast:b[Math.floor(Math.random()*b.length)].id,lunch:m[Math.floor(Math.random()*m.length)].id,snack:sn[Math.floor(Math.random()*sn.length)].id,dinner:m[Math.floor(Math.random()*m.length)].id};
    const t=totals(Object.values(plan));
    const score=Math.abs(t.kcal-target.kcal)*1.2+Math.abs(t.protein-target.protein)*4+(plan.lunch===plan.dinner?120:0);
    if(score<bestScore){bestScore=score;best=plan}
  }
  state.plan[day]=best;save();render();
}
function randomizeWeek(){
  const usage={};
  const b=DISHES.filter(d=>d.category==='Завтрак'),m=DISHES.filter(d=>d.category==='Основное'),sn=DISHES.filter(d=>d.category==='Перекус');
  const choosePlan=()=>{let best=null,bestScore=Infinity;for(let i=0;i<700;i++){const plan={breakfast:b[Math.floor(Math.random()*b.length)].id,lunch:m[Math.floor(Math.random()*m.length)].id,snack:sn[Math.floor(Math.random()*sn.length)].id,dinner:m[Math.floor(Math.random()*m.length)].id};const t=totals(Object.values(plan));const repeat=Object.values(plan).reduce((a,id)=>a+(usage[id]||0)*35,0);const score=Math.abs(t.kcal-target.kcal)*1.2+Math.abs(t.protein-target.protein)*4+repeat+(plan.lunch===plan.dinner?150:0);if(score<bestScore){bestScore=score;best=plan}}return best};
  days.forEach(day=>{const p=choosePlan();state.plan[day]=p;Object.values(p).forEach(id=>usage[id]=(usage[id]||0)+1)});save();render();
}
function shoppingItems(){
  const exact=new Map(), unknown=new Map();
  Object.values(state.plan).forEach(p=>Object.values(p).forEach(id=>{if(!id)return;recipeIngredients(id).forEach(x=>{const name=x.name.trim();if(!name)return;if(x.qty!==''&&x.qty!=null&&!Number.isNaN(Number(x.qty))){const key=`${name}|${x.unit||'г'}`;exact.set(key,(exact.get(key)||0)+Number(x.qty))}else unknown.set(name,(unknown.get(name)||0)+1)})}));
  return {exact:[...exact.entries()].map(([key,qty])=>{const [name,unit]=key.split('|');return {name,unit,qty}}).sort((a,b)=>a.name.localeCompare(b.name,'ru')),unknown:[...unknown.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ru'))};
}
function renderShopping(){const {exact,unknown}=shoppingItems();app.innerHTML=`<section><h2>Покупки</h2><p class="note">Продукты с внесёнными граммовками суммируются автоматически по всей неделе. Остальные пока показываются как количество использований.</p>${exact.length?`<div class="shopping-section"><h3>Точные количества</h3>${exact.map(x=>{const key=`${x.name}|${x.unit}`;return `<label class="shop-row ${state.shopping[key]?'done':''}"><input type="checkbox" ${state.shopping[key]?'checked':''} onchange="toggleShop('${key.replace(/'/g,"\\'")}')"><span>${x.name} <b>${Math.round(x.qty*10)/10} ${x.unit}</b></span></label>`}).join('')}</div>`:''}${unknown.length?`<div class="shopping-section"><h3>Нужно внести граммовки</h3>${unknown.map(([x,n])=>`<label class="shop-row ${state.shopping[x]?'done':''}"><input type="checkbox" ${state.shopping[x]?'checked':''} onchange="toggleShop('${x.replace(/'/g,"\\'")}')"><span>${x} <small class="meta">используется × ${n}</small></span></label>`).join('')}</div>`:''}${!exact.length&&!unknown.length?'<div class="empty">Сначала соберите меню на неделю.</div>':''}</section>`}
function toggleShop(x){state.shopping[x]=!state.shopping[x];save();renderShopping()}
function render(){document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));({today:renderToday,library:renderLibrary,week:renderWeek,shopping:renderShopping}[state.view])()}
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;save();render()});document.querySelector('#closeModal').onclick=()=>modal.classList.add('hidden');modal.onclick=e=>{if(e.target===modal)modal.classList.add('hidden')};
let deferredPrompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;document.querySelector('#installBtn').classList.remove('hidden')});document.querySelector('#installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null}}
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js');render();
