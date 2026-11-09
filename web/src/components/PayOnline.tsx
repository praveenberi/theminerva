import { useEffect, useRef, useState } from 'react';
import { Button, ErrorState } from '@/components/ui';

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load the payment provider script'));
    document.head.appendChild(s);
  });
}

/**
 * Hosted provider widgets. The order is only ever shown as PAID after the provider's signed webhook reaches the server —
 * finishing this widget just redirects/refreshes to the tracking page, which then waits for that confirmation.
 */
export function PayOnline({ result, publishableKey, returnUrl, onSubmitted }: { result: any; publishableKey?: string | null; returnUrl: string; onSubmitted: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{ stripe: any; elements: any } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!result?.clientSecret || !publishableKey) return;
    let cancelled = false;
    loadScript('https://js.stripe.com/v3/').then(() => {
      if (cancelled) return;
      const stripe = (window as any).Stripe(publishableKey);
      const elements = stripe.elements({ clientSecret: result.clientSecret });
      elements.create('payment').mount(mount.current!);
      stripeRef.current = { stripe, elements };
    }).catch(setError);
    return () => { cancelled = true; };
  }, [result?.clientSecret, publishableKey]);

  if (result?.clientSecret) {
    if (!publishableKey) return <ErrorState error={new Error('Card payments are not fully configured (missing publishable key). Please choose another payment method or contact the restaurant.')} />;
    return (
      <div className="space-y-4">
        <div ref={mount} />
        {!!error && <ErrorState error={error} />}
        <Button className="w-full" size="lg" loading={busy} onClick={async () => {
          if (!stripeRef.current) return;
          setBusy(true);
          const { error: err } = await stripeRef.current.stripe.confirmPayment({ elements: stripeRef.current.elements, confirmParams: { return_url: returnUrl }, redirect: 'if_required' });
          setBusy(false);
          if (err) setError(new Error(err.message)); else onSubmitted();
        }}>Pay now</Button>
      </div>
    );
  }
  if (result?.razorpay) {
    const rz = result.razorpay;
    return (
      <Button className="w-full" size="lg" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await loadScript('https://checkout.razorpay.com/v1/checkout.js');
          const R = (window as any).Razorpay;
          new R({ key: rz.keyId, order_id: rz.orderId, amount: rz.amount, handler: () => onSubmitted(), modal: { ondismiss: () => setBusy(false) } }).open();
        } catch (e) { setError(e); setBusy(false); }
      }}>Pay with Razorpay</Button>
    );
  }
  return null;
}
