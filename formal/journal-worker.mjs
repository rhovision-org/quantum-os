import {apply} from './authority-journal.mjs';
const [db,actor,body,crash]=process.argv.slice(2);
const result=apply(db,Number(actor),JSON.parse(body),stage=>{
  if(stage===crash)process.kill(process.pid,'SIGKILL');
});
console.log(JSON.stringify(result));
