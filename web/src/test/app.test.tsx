import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CartProvider, useCart } from '@/lib/cart';
import { Field, Input, Modal } from '@/components/ui';
import { money, setLocaleConfig, statusLabel } from '@/lib/format';

function CartProbe() {
  const { state, dispatch, count, subtotal } = useCart();
  const line = { productId: 'p1', name: 'Soup', addonIds: ['b', 'a'], addonNames: [], unitPrice: 8, quantity: 1 };
  return (
    <div>
      <button onClick={() => dispatch({ t: 'add', line })}>add</button>
      <button onClick={() => dispatch({ t: 'add', line: { ...line, addonIds: ['a', 'b'] } })}>add-same</button>
      <button onClick={() => dispatch({ t: 'qty', key: state.lines[0].key, quantity: 99 })}>big</button>
      <button onClick={() => dispatch({ t: 'table', token: 't', label: 'T3' })}>table</button>
      <output data-testid="out">{count}|{subtotal}|{state.lines.length}|{state.mode}</output>
    </div>
  );
}

describe('cart', () => {
  it('merges identical lines, caps quantity and switches to dine-in for a table', () => {
    localStorage.clear();
    render(<CartProvider><CartProbe /></CartProvider>);
    fireEvent.click(screen.getByText('add'));
    fireEvent.click(screen.getByText('add-same')); // same add-ons in a different order → same line
    expect(screen.getByTestId('out').textContent).toBe('2|16|1|TAKEAWAY');
    fireEvent.click(screen.getByText('big'));
    expect(screen.getByTestId('out').textContent).toBe('50|400|1|TAKEAWAY');
    fireEvent.click(screen.getByText('table'));
    expect(screen.getByTestId('out').textContent).toContain('DINE_IN');
  });
  it('persists to localStorage', () => {
    localStorage.clear();
    render(<CartProvider><CartProbe /></CartProvider>);
    fireEvent.click(screen.getByText('add'));
    expect(JSON.parse(localStorage.getItem('minerva-cart-v1')!).lines).toHaveLength(1);
  });
});

describe('ui', () => {
  it('shows validation errors accessibly', () => {
    render(<Field label="Email" error="Enter a valid email">{(id, d) => <Input id={id} aria-describedby={d} />}</Field>);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email');
  });
  it('modal closes on Escape and is labelled', () => {
    let open = true;
    const { rerender } = render(<Modal open={open} onClose={() => { open = false; }} title="Hello">x</Modal>);
    expect(screen.getByRole('dialog', { name: 'Hello' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(open).toBe(false);
    rerender(<Modal open={open} onClose={() => {}} title="Hello">x</Modal>);
  });
});

describe('format', () => {
  it('formats money using the configured currency', () => {
    setLocaleConfig({ currency: 'SGD', locale: 'en-SG' });
    expect(money(8.5)).toMatch(/8\.50/);
    expect(statusLabel('OUT_FOR_DELIVERY')).toBe('Out for delivery');
  });
});
