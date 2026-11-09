import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Skeleton } from '@/components/ui';
import PublicLayout from '@/components/PublicLayout';
import AdminLayout from '@/components/AdminLayout';
import Home from '@/pages/public/Home';

// route-level code splitting
const L = <T extends { default: React.ComponentType<any> }>(f: () => Promise<T>) => lazy(f);
const Menu = L(() => import('@/pages/public/Menu'));
const Product = L(() => import('@/pages/public/Product'));
const Checkout = L(() => import('@/pages/public/Checkout'));
const Track = L(() => import('@/pages/public/Track'));
const TableOrder = L(() => import('@/pages/public/TableOrder'));
const Reservations = L(() => import('@/pages/public/Reservations'));
const Events = L(() => import('@/pages/public/Events'));
const Info = L(() => import('@/pages/public/Info'));
const Auth = L(() => import('@/pages/public/Auth'));
const Account = L(() => import('@/pages/public/Account'));
const Feedback = L(() => import('@/pages/public/Feedback'));
const ResetPassword = L(() => import('@/pages/public/ResetPassword'));

const AdminLogin = L(() => import('@/pages/admin/Login'));
const Dashboard = L(() => import('@/pages/admin/Dashboard'));
const Orders = L(() => import('@/pages/admin/Orders'));
const Kitchen = L(() => import('@/pages/admin/Kitchen'));
const MenuAdmin = L(() => import('@/pages/admin/MenuAdmin'));
const Tables = L(() => import('@/pages/admin/Tables'));
const ReservationsAdmin = L(() => import('@/pages/admin/ReservationsAdmin'));
const Customers = L(() => import('@/pages/admin/Customers'));
const Inventory = L(() => import('@/pages/admin/Inventory'));
const Marketing = L(() => import('@/pages/admin/Marketing'));
const Staff = L(() => import('@/pages/admin/Staff'));
const Reports = L(() => import('@/pages/admin/Reports'));
const Content = L(() => import('@/pages/admin/Content'));
const SettingsPage = L(() => import('@/pages/admin/Settings'));
const Assistant = L(() => import('@/pages/admin/Assistant'));
const Payments = L(() => import('@/pages/admin/Payments'));

const Fallback = () => <div className="mx-auto max-w-5xl space-y-4 p-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>;

export default function App() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Home />} />
          <Route path="menu" element={<Menu />} />
          <Route path="order" element={<Menu />} />
          <Route path="menu/:slug" element={<Product />} />
          <Route path="checkout" element={<Checkout />} />
          <Route path="track/:token" element={<Track />} />
          <Route path="t/:token" element={<TableOrder />} />
          <Route path="reservations" element={<Reservations />} />
          <Route path="events" element={<Events />} />
          <Route path="feedback" element={<Feedback />} />
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="login" element={<Auth mode="login" />} />
          <Route path="register" element={<Auth mode="register" />} />
          <Route path="account" element={<Account />} />
          <Route path="account/:tab" element={<Account />} />
          <Route path="about" element={<Info page="about" />} />
          <Route path="gallery" element={<Info page="gallery" />} />
          <Route path="offers" element={<Info page="offers" />} />
          <Route path="loyalty" element={<Info page="loyalty" />} />
          <Route path="contact" element={<Info page="contact" />} />
          <Route path="privacy" element={<Info page="privacy" />} />
          <Route path="terms" element={<Info page="terms" />} />
          <Route path="refunds" element={<Info page="refunds" />} />
          <Route path="*" element={<Info page="notfound" />} />
        </Route>
        <Route path="admin/login" element={<AdminLogin />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="orders" element={<Orders />} />
          <Route path="kitchen" element={<Kitchen />} />
          <Route path="menu" element={<MenuAdmin />} />
          <Route path="tables" element={<Tables />} />
          <Route path="reservations" element={<ReservationsAdmin />} />
          <Route path="customers" element={<Customers />} />
          <Route path="payments" element={<Payments />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="marketing" element={<Marketing />} />
          <Route path="staff" element={<Staff />} />
          <Route path="reports" element={<Reports />} />
          <Route path="content" element={<Content />} />
          <Route path="assistant" element={<Assistant />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
