import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { DEV_SHOP } from "../../lib/context.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop") || DEV_SHOP) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>PID Ready</h1>
        <p className={styles.text}>
          Find and fix missing EU customs product IDs before parcels get held at the border.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>See the gap in minutes</strong>. Every variant checked for SKU, manufacturer code and barcode.
          </li>
          <li>
            <strong>Fix fast</strong>. Inline edits, bulk actions and CSV round-trip.
          </li>
          <li>
            <strong>Get codes from suppliers</strong>. One link, no email back-and-forth.
          </li>
        </ul>
      </div>
    </div>
  );
}
