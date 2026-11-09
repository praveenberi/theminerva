import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Send, Sparkles } from 'lucide-react';
import { Button, Card, ErrorState, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

const SUGGESTIONS = ['What are today’s total sales?', 'Which dishes are selling the most this month?', 'Which items have low stock?', 'What are our busiest hours?', 'Which customers have not visited recently?', 'What are the most common customer complaints?', 'Which menu items should we promote?'];

export default function Assistant() {
  useSeo('AI assistant');
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api('/api/ai/status') });
  const [msgs, setMsgs] = useState<Array<{ role: 'user' | 'assistant'; content: string; tools?: string[] }>>([]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: (history: typeof msgs) => api('/api/ai/chat', { body: { messages: history.map(({ role, content }) => ({ role, content })) } }),
    onSuccess: (r) => { setMsgs((m) => [...m, { role: 'assistant', content: r.answer, tools: r.toolsUsed }]); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50); },
  });
  const ask = (q: string) => { if (!q.trim() || send.isPending) return; const next = [...msgs, { role: 'user' as const, content: q.trim() }]; setMsgs(next); setText(''); send.mutate(next); };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div><h2 className="flex items-center gap-2 text-2xl"><Sparkles className="h-6 w-6 text-accent" /> Restaurant assistant</h2>
        <p className="text-sm text-muted">Answers come from your live database through permission-checked queries — you only see data your role allows. If the data isn’t there, it says so.</p></div>
      {status.data && !status.data.configured && <Card className="border-warn/40 bg-warn/5 p-4 text-sm"><b>AI provider not configured.</b> Set <code>ANTHROPIC_API_KEY</code> on the server to enable the assistant. Nothing is simulated in the meantime.</Card>}
      <Card className="min-h-[360px] space-y-4 p-4" aria-live="polite">
        {msgs.length === 0 && <div className="space-y-2"><p className="text-sm text-muted">Try asking:</p><div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-border px-3 py-1.5 text-left text-sm hover:bg-surface-2">{s}</button>)}</div></div>}
        {msgs.map((m, i) => (
          <div key={i} className={cn('max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm', m.role === 'user' ? 'ml-auto bg-brand text-brand-fg' : 'bg-surface-2')}>
            {m.content}{m.tools && m.tools.length > 0 && <p className="mt-2 text-xs text-muted">Data used: {[...new Set(m.tools)].join(', ')}</p>}
          </div>))}
        {send.isPending && <p className="text-sm text-muted">Looking at your data…</p>}
        {send.error && <ErrorState error={send.error} />}
        <div ref={end} />
      </Card>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <Input aria-label="Ask a question" placeholder="Ask about sales, stock, customers…" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        <Button loading={send.isPending} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
