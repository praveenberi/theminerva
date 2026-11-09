import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Field, Input, Modal, QueryBoundary, Select, Tabs, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';

const ROLES = ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER', 'CASHIER', 'DELIVERY'];
type Tab = 'team' | 'shifts' | 'attendance' | 'tasks' | 'performance';

export default function Staff() {
  useSeo('Staff');
  const [tab, setTab] = useState<Tab>('team');
  return <div className="space-y-4"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'team', label: 'Team' }, { id: 'shifts', label: 'Shifts' }, { id: 'attendance', label: 'Attendance' }, { id: 'tasks', label: 'Tasks' }, { id: 'performance', label: 'Performance' }]} />
    {tab === 'team' ? <Team /> : tab === 'shifts' ? <Shifts /> : tab === 'attendance' ? <Attendance /> : tab === 'tasks' ? <Tasks /> : <Performance />}</div>;
}

function useTeam() { return useQuery({ queryKey: ['staff'], queryFn: () => api('/api/staff') }); }

function Team() {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const q = useTeam();
  const { all: branches } = useOutletFilter();
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => (v.id ? api(`/api/staff/${v.id}`, { method: 'PUT', body: { name: v.name, role: v.role, isActive: v.isActive, phone: v.phone || null, outletId: v.outletId || null, ...(v.password ? { password: v.password } : {}) } }) : api('/api/staff', { body: { email: v.email, name: v.name, role: v.role, password: v.password, phone: v.phone || undefined, outletId: v.outletId || undefined } })), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['staff'] }); toast('success', 'Saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<div className="space-y-4"><Button onClick={() => setF({ email: '', name: '', role: 'WAITER', password: '', isActive: true })}><Plus className="h-4 w-4" /> Add staff</Button>
    <QueryBoundary q={q}>{(d) => <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead><tbody>{d.map((u: any) => <tr key={u.id} className="border-b border-border/60 last:border-0"><td className="p-3"><span className="font-medium">{u.name}</span><br /><span className="text-xs text-muted">{u.email}</span></td><td>{statusLabel(u.role)}</td><td><Badge tone={u.isActive ? 'success' : 'danger'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge></td><td className="text-muted">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'}</td><td className="pr-3 text-right"><Button size="sm" variant="ghost" onClick={() => setF({ ...u, password: '' })}>Edit</Button>{u.id !== user?.id && <ConfirmButton size="sm" variant="ghost" className={u.isActive ? 'text-danger' : ''} message={u.isActive ? `Deactivate ${u.name}? They are signed out immediately.` : `Reactivate ${u.name}?`} onConfirm={() => save.mutate({ ...u, isActive: !u.isActive })}>{u.isActive ? 'Deactivate' : 'Reactivate'}</ConfirmButton>}</td></tr>)}</tbody></table></Card>}</QueryBoundary>
    <Card className="p-4 text-sm"><h3 className="mb-2 text-lg">What each role can do</h3><ul className="grid gap-1 text-muted sm:grid-cols-2"><li><b>Owner</b> — everything, settings, integrations, audit log</li><li><b>Manager</b> — daily operations, menu, staff, inventory, reports</li><li><b>Kitchen</b> — kitchen display, preparation status</li><li><b>Waiter</b> — tables, dine-in orders, reservations, cash</li><li><b>Cashier</b> — payments, receipts, refunds</li><li><b>Delivery</b> — only their assigned deliveries</li></ul></Card>
    <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? `Edit ${f.name}` : 'Add staff member'}>{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      {!f.id && <Field label="Email">{(id) => <Input id={id} type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>}
      <div className="grid grid-cols-2 gap-4"><Field label="Name">{(id) => <Input id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field><Field label="Role">{(id) => <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{statusLabel(r)}</option>)}</Select>}</Field></div>
      <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
      {branches.length > 0 && <Field label="Branch" hint="Staff assigned to a branch only see that branch">{(id) => <Select id={id} value={f.outletId ?? ''} onChange={(e) => setF({ ...f, outletId: e.target.value })}><option value="">All branches (head office)</option>{branches.filter((b: any) => b.isActive).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>}
      <Field label={f.id ? 'New password (leave blank to keep)' : 'Temporary password'} hint="10+ characters, upper & lower case and a number">{(id) => <Input id={id} type="password" autoComplete="new-password" required={!f.id} minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
      <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Shifts() {
  const qc = useQueryClient(); const toast = useToast();
  const team = useTeam();
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const q = useQuery({ queryKey: ['shifts'], queryFn: () => api('/api/staff/shifts', { query: { from: from.toISOString(), to: new Date(from.getTime() + 14 * 864e5).toISOString() } }) });
  const [f, setF] = useState<any>(null);
  const add = useMutation({ mutationFn: () => api('/api/staff/shifts', { body: { userId: f.userId, startAt: new Date(f.startAt).toISOString(), endAt: new Date(f.endAt).toISOString(), notes: f.notes || undefined } }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['shifts'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/staff/shifts/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }) });
  return (<div className="space-y-4"><Button onClick={() => setF({ userId: team.data?.[0]?.id ?? '', startAt: '', endAt: '' })}><Plus className="h-4 w-4" /> Schedule shift</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="divide-y divide-border">{d.map((s: any) => <div key={s.id} className="flex items-center justify-between p-3 text-sm"><span><b>{s.user.name}</b> <span className="text-muted">({statusLabel(s.user.role)})</span><br />{dateTime(s.startAt)} → {dateTime(s.endAt)}{s.notes && ` · ${s.notes}`}</span><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Remove this shift?" onConfirm={() => del.mutate(s.id)}>×</ConfirmButton></div>)}</Card>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="Schedule shift">{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <Field label="Staff member">{(id) => <Select id={id} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{(team.data ?? []).filter((u: any) => u.isActive).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
      <div className="grid grid-cols-2 gap-4"><Field label="Start">{(id) => <Input id={id} type="datetime-local" required value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value })} />}</Field><Field label="End">{(id) => <Input id={id} type="datetime-local" required value={f.endAt} onChange={(e) => setF({ ...f, endAt: e.target.value })} />}</Field></div>
      <Field label="Notes">{(id) => <Input id={id} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field><div className="flex justify-end"><Button loading={add.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Attendance() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['attendance'], queryFn: () => api('/api/staff/attendance') });
  const clock = useMutation({ mutationFn: () => api('/api/staff/attendance/clock', { body: {} }), onSuccess: (r) => { toast('success', r.clockOut ? 'Clocked out' : 'Clocked in'); qc.invalidateQueries({ queryKey: ['attendance'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<div className="space-y-4"><Button onClick={() => clock.mutate()} loading={clock.isPending}>Clock in / out (me)</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="divide-y divide-border">{d.map((a: any) => <div key={a.id} className="flex justify-between p-3 text-sm"><b>{a.user.name}</b><span>{dateTime(a.clockIn)} → {a.clockOut ? dateTime(a.clockOut) : <Badge tone="success">on shift</Badge>}</span></div>)}</Card>}</QueryBoundary></div>);
}

function Tasks() {
  const qc = useQueryClient(); const toast = useToast();
  const team = useTeam();
  const q = useQuery({ queryKey: ['tasks'], queryFn: () => api('/api/staff/tasks') });
  const [f, setF] = useState({ assigneeId: '', title: '', dueAt: '' });
  const add = useMutation({ mutationFn: () => api('/api/staff/tasks', { body: { assigneeId: f.assigneeId || team.data?.[0]?.id, title: f.title, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined } }), onSuccess: () => { setF({ ...f, title: '' }); qc.invalidateQueries({ queryKey: ['tasks'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const done = useMutation({ mutationFn: (id: string) => api(`/api/staff/tasks/${id}/done`, { body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  return (<div className="space-y-4"><form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}><Select aria-label="Assignee" className="w-48" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>{(team.data ?? []).filter((u: any) => u.isActive).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select><Input aria-label="Task" required placeholder="Task…" className="w-72" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /><Input aria-label="Due" type="datetime-local" className="w-52" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /><Button loading={add.isPending}>Assign</Button></form>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="divide-y divide-border">{d.map((t: any) => <div key={t.id} className="flex items-center justify-between p-3 text-sm"><span className={t.doneAt ? 'text-muted line-through' : ''}>{t.title} <span className="text-muted">— {t.assignee.name}{t.dueAt && `, due ${dateTime(t.dueAt)}`}</span></span>{!t.doneAt && <Button size="sm" variant="outline" onClick={() => done.mutate(t.id)}>Done</Button>}</div>)}</Card>}</QueryBoundary></div>);
}

function Performance() {
  const q = useQuery({ queryKey: ['perf'], queryFn: () => api('/api/staff/performance') });
  return <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Staff</th><th>Role</th><th>Status changes (30d)</th><th>Orders completed</th></tr></thead><tbody>{d.map((u: any) => <tr key={u.id} className="border-b border-border/60 last:border-0"><td className="p-3">{u.name}</td><td>{statusLabel(u.role)}</td><td>{u.handled}</td><td>{u.completed}</td></tr>)}</tbody></table></Card>}</QueryBoundary>;
}
