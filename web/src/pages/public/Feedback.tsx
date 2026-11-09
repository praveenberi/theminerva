import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { Button, Card, Field, Input, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSeo } from '@/lib/hooks';
import { cn } from '@/lib/format';

export default function Feedback() {
  useSeo('Feedback');
  const { user } = useAuth();
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [name, setName] = useState(user?.name ?? '');
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const m = useMutation({ mutationFn: () => api('/api/public/reviews', { body: { authorName: name, rating, comment: comment || undefined } }), onSuccess: () => setSent(true), onError: (e) => toast('error', errorMessage(e)) });
  if (sent) return <div className="mx-auto max-w-md px-4 py-20 text-center"><h1 className="text-4xl">Thank you</h1><p className="mt-2 text-muted">Your feedback helps us improve. It will appear on the site once reviewed.</p></div>;
  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-4xl">Tell us how we did</h1>
      <Card className="mt-6 space-y-4 p-5">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!rating) return toast('error', 'Please choose a rating'); m.mutate(); }}>
          <fieldset><legend className="mb-1 text-sm font-medium">Rating</legend>
            <div className="flex gap-1" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => <button type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} key={n} onClick={() => setRating(n)}><Star className={cn('h-8 w-8', n <= rating ? 'fill-accent text-accent' : 'text-border')} /></button>)}</div></fieldset>
          <Field label="Your name">{(id) => <Input id={id} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Comments">{(id) => <Textarea id={id} maxLength={1500} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
          <Button loading={m.isPending}>Send feedback</Button>
        </form>
      </Card>
    </div>
  );
}
