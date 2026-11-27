"""Independent bounded oracle: rights are sets, ancestry via parent pointers.
No runtime imports, no network, no live identities. Output expected decisions
and canonical projections of post-state, including every denied transition."""
import json
from collections import deque

def genesis():
    return ({0:(0,7,frozenset(range(6)),None)},frozenset(),frozenset())

def advance(s,actor,c):
    grants,revoked,seen=s
    def deny(reason): return False,reason,s
    def accept(g=grants,r=revoked): return True,'accepted',(g,r,seen|{c['request']})
    if c['request'] in seen:return deny('replay')
    if c['kind']=='revoke':
        if actor!=0:return deny('owner-only')
        if c['id'] not in grants:return deny('unknown-grant')
        if c['id'] in revoked:return deny('already-revoked')
        return accept(r=revoked|{c['id']})
    parent=c['parent']
    if parent not in grants:return deny('unknown-grant')
    holder,process,rights,_=grants[parent]
    if holder!=actor:return deny('wrong-holder')
    cursor=parent
    while cursor is not None:
        if cursor in revoked:return deny('revoked')
        cursor=grants[cursor][3]
    if process!=c['process']:return deny('wrong-process')
    if c['kind']=='execute':
        if c['right'] not in rights:return deny('missing-right')
        return accept()
    if 3 not in rights:return deny('missing-right')
    if c['id'] in grants or c['id'] in revoked:return deny('id-used')
    child=frozenset(i for i in range(6) if c['mask']&(2**i))
    if not child<=rights:return deny('amplification')
    g=dict(grants);g[c['id']]=(c['target'],process,child,parent)
    return accept(g=g)

def project(s):
    g,r,v=s
    rows=[]
    for id,(holder,process,rights,parent) in sorted(g.items()):
        lineage=[id]
        while parent is not None:
            lineage.append(parent);parent=g[parent][3]
        rows.append(dict(id=id,holder=holder,process=process,mask=sum(2**i for i in rights),lineage=lineage))
    return dict(grants=rows,revoked=sorted(r),seen=sorted(v))

def action(actor,kind,request,**kw):return dict(actor=actor,command=dict(kind=kind,request=request,**kw))

# Finite command alphabet: two branches, a nested delegate, escalation,
# alternate holder/process, replay across verbs, ancestor/root revocation.
ops=[
 action(0,'grant',1,parent=0,id=1,target=1,process=7,mask=10),
 action(0,'grant',2,parent=0,id=2,target=2,process=7,mask=2),
 action(1,'grant',3,parent=1,id=3,target=2,process=7,mask=2),
 action(1,'grant',4,parent=1,id=3,target=2,process=7,mask=34),
 action(1,'grant',5,parent=1,id=2,target=2,process=7,mask=2),
 action(2,'grant',6,parent=2,id=3,target=1,process=7,mask=2),
 action(0,'revoke',7,id=1),
 action(0,'revoke',8,id=2),
 action(0,'revoke',9,id=0),
 action(0,'revoke',10,id=3),
 action(1,'revoke',11,id=0),
 action(0,'revoke',1,id=1),
 action(0,'revoke',12,id=4),
 action(1,'execute',13,parent=1,process=7,right=1),
 action(2,'execute',14,parent=2,process=7,right=1),
 action(2,'execute',15,parent=3,process=7,right=1),
 action(2,'execute',16,parent=1,process=7,right=1),
 action(1,'execute',17,parent=1,process=8,right=1),
 action(1,'execute',18,parent=1,process=7,right=5),
 action(0,'execute',19,parent=0,process=7,right=5),
 action(0,'grant',20,parent=0,id=1,target=2,process=7,mask=63),
 action(0,'grant',21,parent=0,id=4,target=2,process=8,mask=2),
]
# Breadth-first search distinct normalized reachable states, up to four
# accepted transitions; every outgoing command from those states is checked.
q=deque([(genesis(),[])])
visited={json.dumps(project(genesis()),sort_keys=True)}
count=0
with open('authority-lifecycle-vectors.jsonl','w') as out:
    while q:
        s,path=q.popleft()
        for i,a in enumerate(ops):
            accepted,reason,t=advance(s,a['actor'],a['command'])
            out.write(json.dumps(dict(path=path,action=i,accepted=accepted,reason=reason,state=project(t)),separators=(',',':'))+'\n')
            count+=1
            key=json.dumps(project(t),sort_keys=True)
            if accepted and len(path)<4 and key not in visited:
                visited.add(key);q.append((t,path+[i]))
with open('authority-lifecycle-commands.json','w') as out:json.dump(ops,out)
print(f'Oracle: {len(visited)} reachable states; {count} outgoing decisions; accepted-depth ≤ 4')
