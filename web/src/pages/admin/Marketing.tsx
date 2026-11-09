import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Field, Input, Modal, QueryBoundary, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

type Tab = 'coupons' | 'rules' | 'banners' | 'campaigns';
export default function Marketing() {
  useSeo('Marketing');
  const [tab, setTab] = useState<Tab>('coupons');
  return (<div className="space-y-4"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'coupons', label: 'Coupons' }, { id: 'rules', label: 'Happy hour & pricing' }, { id: 'banners', label: 'Banners' }, { id: 'campaigns', label: 'Campaigns' }]} />
    {tab === 'coupons' ? <Coupons /> : tab === 'rules' ? <Rules /> : tab === 'banners' ? <Banners /> : <Campaigns />}</div>);
}

function useCats() { return useQuery({ queryKey: ['menus'], queryFn: () => api('/api/menus') }); }
const catOptions = (menus: any[]) => menus.flatMap((m) => m.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>));
const localInput = (d?: string | null) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

function Coupons() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['coupons'], queryFn: () => api('/api/marketing/coupons') });
  const menus = useCats();
  const [f, setF] = useState<any>(null);
  const save = useMutation({
    mutationFn: (v: any) => { const b = { code: v.code, description: v.description || null, type: v.type, value: Number(v.value || 0), minSubtotal: Number(v.minSubtotal || 0), categoryId: v.categoryId || null, startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null, startTime: v.startTime || '', endTime: v.endTime || '', maxUses: v.maxUses ? Number(v.maxUses) : null, isActive: v.isActive ?? true }; return v.id ? api(`/api/marketing/coupons/${v.id}`, { method: 'PUT', body: b }) : api('/api/marketing/coupons', { body: b }); },
    onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['coupons'] }); toast('success', 'Coupon saved'); }, onError: (e) => toast('error', errorMessage(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/marketing/coupons/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['coupons'] }) });
  return (<div className="space-y-4"><Button onClick={() => setF({ code: '', type: 'PERCENT', value: 10, isActive: true })}><Plus className="h-4 w-4" /> Coupon</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Code</th><th>Offer</th><th>Status</th><th>Used</th><th>Orders</th><th>Revenue</th><th /></tr></thead><tbody>{d.map((c: any) => <tr key={c.id} className="border-b border-border/60 last:border-0"><td className="p-3 font-mono font-semibold">{c.code}</td><td>{c.type === 'PERCENT' ? `${Number(c.value)}% off` : c.type === 'FIXED' ? `${money(c.value)} off` : 'Buy one get one'}{Number(c.minSubtotal) > 0 && ` · min ${money(c.minSubtotal)}`}</td><td><Badge tone={c.status === 'ACTIVE' ? 'success' : c.status === 'SCHEDULED' ? 'brand' : 'neutral'}>{statusLabel(c.status)}</Badge></td><td>{c.usedCount}{c.maxUses ? ` / ${c.maxUses}` : ''}</td><td>{c.completedOrders}</td><td>{money(c.revenue)}</td><td className="whitespace-nowrap pr-3 text-right"><Button size="sm" variant="ghost" onClick={() => setF({ ...c, value: Number(c.value), minSubtotal: Number(c.minSubtotal), startsAt: localInput(c.startsAt), endsAt: localInput(c.endsAt), startTime: c.startTime ?? '', endTime: c.endTime ?? '', categoryId: c.categoryId ?? '', maxUses: c.maxUses ?? '' })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Delete ${c.code}? Codes used in past orders are deactivated instead.`} onConfirm={() => del.mutate(c.id)}>×</ConfirmButton></td></tr>)}</tbody></table></Card>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit coupon' : 'New coupon'} wide>{f && <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      <Field label="Code">{(id) => <Input id={id} required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
      <Field label="Type">{(id) => <Select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="PERCENT">Percentage off</option><option value="FIXED">Fixed amount off</option><option value="BOGO">Buy one get one</option></Select>}</Field>
      {f.type !== 'BOGO' && <Field label={f.type === 'PERCENT' ? 'Percent' : 'Amount'}>{(id) => <Input id={id} type="number" step="0.01" min="0" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>}
      <Field label="Minimum spend">{(id) => <Input id={id} type="number" step="0.01" min="0" value={f.minSubtotal ?? 0} onChange={(e) => setF({ ...f, minSubtotal: e.target.value })} />}</Field>
      <Field label="Only for category">{(id) => <Select id={id} value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Whole order</option>{catOptions(menus.data ?? [])}</Select>}</Field>
      <Field label="Max uses">{(id) => <Input id={id} type="number" min={1} value={f.maxUses ?? ''} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />}</Field>
      <Field label="Starts">{(id) => <Input id={id} type="datetime-local" value={f.startsAt ?? ''} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />}</Field>
      <Field label="Expires">{(id) => <Input id={id} type="datetime-local" value={f.endsAt ?? ''} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />}</Field>
      <Field label="Daily window from">{(id) => <Input id={id} type="time" value={f.startTime ?? ''} onChange={(e) => setF({ ...f, startTime: e.target.value })} />}</Field>
      <Field label="Daily window until">{(id) => <Input id={id} type="time" value={f.endTime ?? ''} onChange={(e) => setF({ ...f, endTime: e.target.value })} />}</Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.isActive ?? true} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (scheduled coupons activate and expire automatically)</label>
      <div className="flex justify-end sm:col-span-2"><Button loading={save.isPending}>Save coupon</Button></div></form>}</Modal></div>);
}

function Rules() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['rules'], queryFn: () => api('/api/marketing/pricing-rules') });
  const menus = useCats();
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => { const b = { name: v.name, categoryId: v.categoryId || null, percentOff: Number(v.percentOff), startTime: v.startTime || '', endTime: v.endTime || '', days: v.days ?? [], isActive: v.isActive ?? true }; return v.id ? api(`/api/marketing/pricing-rules/${v.id}`, { method: 'PUT', body: b }) : api('/api/marketing/pricing-rules', { body: b }); }, onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['rules'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/marketing/pricing-rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }) });
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (<div className="space-y-4"><p className="text-sm text-muted">Automatic time-based discounts (happy hour). They apply to menu prices without a code, within the daily window and chosen weekdays.</p><Button onClick={() => setF({ name: '', percentOff: 15, days: [], isActive: true })}><Plus className="h-4 w-4" /> Rule</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((r: any) => <Card key={r.id} className="p-4"><div className="flex items-start justify-between"><div><p className="font-medium">{r.name} {!r.isActive && <Badge>Paused</Badge>}</p><p className="text-sm text-muted">{Number(r.percentOff)}% off · {r.startTime ? `${r.startTime}–${r.endTime}` : 'all day'} · {r.days.length ? r.days.map((x: number) => DAYS[x]).join(', ') : 'every day'}</p></div><div><Button size="sm" variant="ghost" onClick={() => setF({ ...r, percentOff: Number(r.percentOff), categoryId: r.categoryId ?? '', startTime: r.startTime ?? '', endTime: r.endTime ?? '' })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete this rule?" onConfirm={() => del.mutate(r.id)}>×</ConfirmButton></div></div></Card>)}</div>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit rule' : 'New pricing rule'}>{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <div className="grid grid-cols-2 gap-4"><Field label="Percent off">{(id) => <Input id={id} type="number" min={1} max={90} required value={f.percentOff} onChange={(e) => setF({ ...f, percentOff: e.target.value })} />}</Field><Field label="Category">{(id) => <Select id={id} value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">All dishes</option>{catOptions(menus.data ?? [])}</Select>}</Field>
        <Field label="From">{(id) => <Input id={id} type="time" value={f.startTime ?? ''} onChange={(e) => setF({ ...f, startTime: e.target.value })} />}</Field><Field label="Until">{(id) => <Input id={id} type="time" value={f.endTime ?? ''} onChange={(e) => setF({ ...f, endTime: e.target.value })} />}</Field></div>
      <fieldset><legend className="mb-1 text-sm font-medium">Days (none = every day)</legend><div className="flex flex-wrap gap-2">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent/10"><input type="checkbox" className="sr-only" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x: number) => x !== i) })} />{d}</label>)}</div></fieldset>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
      <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Banners() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['banners'], queryFn: () => api('/api/marketing/banners') });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => { const b = { title: v.title, subtitle: v.subtitle || null, linkUrl: v.linkUrl || null, isActive: v.isActive ?? true, startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null }; return v.id ? api(`/api/marketing/banners/${v.id}`, { method: 'PUT', body: b }) : api('/api/marketing/banners', { body: b }); }, onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['banners'] }); qc.invalidateQueries({ queryKey: ['home'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/marketing/banners/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['banners'] }) });
  return (<div className="space-y-4"><Button onClick={() => setF({ title: '', isActive: true })}><Plus className="h-4 w-4" /> Banner</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((b: any) => <Card key={b.id} className="flex items-start justify-between p-4"><div><p className="font-medium">{b.title} {!b.isActive && <Badge>Hidden</Badge>}</p><p className="text-sm text-muted">{b.subtitle}{b.startsAt && ` · from ${dateTime(b.startsAt)}`}{b.endsAt && ` · until ${dateTime(b.endsAt)}`}</p></div><div><Button size="sm" variant="ghost" onClick={() => setF({ ...b, startsAt: localInput(b.startsAt), endsAt: localInput(b.endsAt) })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete banner?" onConfirm={() => del.mutate(b.id)}>×</ConfirmButton></div></Card>)}</div>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="Promotional banner">{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      <Field label="Title">{(id) => <Input id={id} required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field><Field label="Subtitle">{(id) => <Input id={id} value={f.subtitle ?? ''} onChange={(e) => setF({ ...f, subtitle: e.target.value })} />}</Field><Field label="Link (path)">{(id) => <Input id={id} placeholder="/menu" value={f.linkUrl ?? ''} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} />}</Field>
      <div className="grid grid-cols-2 gap-4"><Field label="Show from">{(id) => <Input id={id} type="datetime-local" value={f.startsAt ?? ''} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />}</Field><Field label="Until">{(id) => <Input id={id} type="datetime-local" value={f.endsAt ?? ''} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />}</Field></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label><div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Campaigns() {
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api('/api/campaigns') });
  const an = useQuery({ queryKey: ['campaign-analytics'], queryFn: () => api('/api/campaigns/analytics') });
  const [f, setF] = useState<any>(null);
  const create = useMutation({ mutationFn: (v: any) => api('/api/campaigns', { body: { name: v.name, channel: v.channel, segment: v.segment, subject: v.subject || undefined, body: v.body, couponCode: v.couponCode || undefined } }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['campaigns'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const send = useMutation({ mutationFn: (id: string) => api(`/api/campaigns/${id}/send`, { body: {} }), onSuccess: (r) => { toast(r.sentCount ? 'success' : 'error', r.note ?? `Sent to ${r.sentCount} of ${r.recipients} opted-in customers`); qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['campaign-analytics'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/campaigns/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }), onError: (e) => toast('error', errorMessage(e)) });
  const draft = useMutation({ mutationFn: () => api('/api/ai/marketing', { body: { goal: f.name || 'Bring customers back', channel: f.channel } }), onSuccess: (r) => setF({ ...f, body: r.text }), onError: (e) => toast('error', errorMessage(e)) });
  return (<div className="space-y-4"><p className="text-sm text-muted">Messages go only to customers who opted in to marketing and haven’t unsubscribed. Sending requires the email / WhatsApp provider to be configured (Settings → Integrations); undelivered messages are reported as failed, never as sent.</p>
    <Button onClick={() => setF({ name: '', channel: 'EMAIL', segment: 'ALL', body: 'Hi {{name}}, ' })}><Plus className="h-4 w-4" /> Campaign</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <ul className="space-y-3">{d.map((c: any) => { const a = (an.data ?? []).find((x: any) => x.id === c.id); return <Card key={c.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{c.name} <Badge>{c.channel}</Badge> <Badge>{statusLabel(c.segment)}</Badge></p><p className="line-clamp-1 text-sm text-muted">{c.body}</p></div>
      <div className="flex items-center gap-2"><Badge tone={c.status === 'SENT' ? 'success' : 'warn'}>{statusLabel(c.status)}</Badge>{c.status === 'DRAFT' && <><ConfirmButton size="sm" message={`Send “${c.name}” to the ${statusLabel(c.segment).toLowerCase()} segment (opted-in customers only)?`} onConfirm={() => send.mutate(c.id)}>Send</ConfirmButton><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete this draft?" onConfirm={() => del.mutate(c.id)}>×</ConfirmButton></>}</div></div>
      {c.status === 'SENT' && <p className="mt-2 text-sm">Delivered {c.sentCount} · failed {c.failedCount}{a && c.couponCode ? ` · ${a.orders} orders, ${money(a.revenue)} attributed to code ${c.couponCode}` : ''}</p>}</Card>; })}</ul>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="New campaign" wide>{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(f); }}>
      <div className="grid gap-4 sm:grid-cols-3"><Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field><Field label="Channel">{(id) => <Select id={id} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="EMAIL">Email</option><option value="WHATSAPP">WhatsApp</option></Select>}</Field><Field label="Audience">{(id) => <Select id={id} value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })}>{['ALL', 'NEW', 'RETURNING', 'VIP', 'INACTIVE', 'HIGH_SPEND', 'BIRTHDAY'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select>}</Field></div>
      {f.channel === 'EMAIL' && <Field label="Subject">{(id) => <Input id={id} required value={f.subject ?? ''} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field>}
      <Field label="Message" hint="Use {{name}} for the customer’s name">{(id) => <Textarea id={id} required className="min-h-32" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
      <div className="flex items-end gap-3"><Field label="Coupon code to track (optional)" className="flex-1">{(id) => <Input id={id} value={f.couponCode ?? ''} onChange={(e) => setF({ ...f, couponCode: e.target.value.toUpperCase() })} />}</Field>{can('ai.use') && <Button type="button" variant="outline" loading={draft.isPending} onClick={() => draft.mutate()}><Sparkles className="h-4 w-4" /> Draft with AI</Button>}</div>
      <div className="flex justify-end"><Button loading={create.isPending}>Save draft</Button></div></form>}</Modal></div>);
}
