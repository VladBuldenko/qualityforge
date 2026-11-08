import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "./auth";
import { AppLayout, PublicLayout } from "./Layout";
import { CartPage, CartProvider } from "./cart";
import { TopUpResultPage, WalletPage } from "./wallet";
import { Shop, ProductDetail } from "./shop";
import { Dashboard, Home, Login, NotFound, Profile, Register } from "./pages";

// The catalog is public; signed-in users see it inside the app shell (sidebar).
function CatalogLayout() {
  const { user } = useAuth();
  return user ? <AppLayout /> : <PublicLayout />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route element={<CatalogLayout />}>
            <Route path="/shop" element={<Shop />} />
            <Route path="/shop/:slug" element={<ProductDetail />} />
          </Route>
          <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/wallet/top-up/result" element={<TopUpResultPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/profile" element={<Profile />} />
          </Route>
        </Routes>
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
