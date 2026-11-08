import { toast } from "sonner";

/** Ephemeral feedback — prefer these over shell banners. */
export const notify = {
  success(message: string): void {
    toast.success(message);
  },
  info(message: string): void {
    toast.message(message);
  },
  warning(message: string): void {
    toast.warning(message);
  },
  error(message: string): void {
    toast.error(message);
  },
  loading(message: string, id: string): string | number {
    return toast.loading(message, { id });
  },
  dismiss(id?: string): void {
    toast.dismiss(id);
  },
};
