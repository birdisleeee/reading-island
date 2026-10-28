import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {journalView,updateJournalView} from '../web/visual.mjs';
const book={book_id:'fixture',title:'原创书',author:'示例作者'},doc={document_id:'doc',reading_status:'ready',chapters:[{title:'第一章',start:0,end:10}]};
function fixture(){const {document}=parseHTML('<main id="app"></main>');return document.querySelector('main');}
test('journal tabs retain connected profile, decoded cover and scroll container while changing panel',()=>{
  const app=fixture();updateJournalView(app,journalView(book,[],[],'original',doc));
  app.append(app.querySelector('.journal-bottom'));
  const screen=app.querySelector('.journal-screen'),profile=app.querySelector('.book-profile'),image=profile.querySelector('img'),head=app.querySelector('.journal-head');
  screen.scrollTop=130;
  for(const tab of ['excerpt','discussion','original']){
    updateJournalView(app,journalView(book,[],[],tab,doc));app.append(app.querySelector('.journal-bottom'));
    assert.equal(app.querySelector('.journal-screen'),screen);assert.equal(app.querySelector('.book-profile'),profile);assert.equal(app.querySelector('img'),image);assert.equal(app.querySelector('.journal-head'),head);assert.equal(screen.scrollTop,130);
    assert.equal(app.querySelector('.journal-tabs .active').dataset.value,tab);assert.equal(app.querySelectorAll('.journal-bottom').length,1);
  }
});
test('late cover data patches the retained image; metadata and another book update correctly',()=>{
  const app=fixture();updateJournalView(app,journalView(book,[],[],'original',doc));const profile=app.querySelector('.book-profile'),image=profile.querySelector('img');
  updateJournalView(app,journalView({...book,cover_data:'blob:fixture'},[],[],'excerpt',doc));
  assert.equal(app.querySelector('.book-profile'),profile);assert.equal(image.getAttribute('src'),'blob:fixture');
  updateJournalView(app,journalView({...book,title:'改名'},[],[],'excerpt',doc));assert.match(app.querySelector('.book-profile').textContent,/改名/);
  const screen=app.querySelector('.journal-screen');updateJournalView(app,journalView({...book,book_id:'second'},[],[],'original',doc));assert.notEqual(app.querySelector('.journal-screen'),screen);
});
