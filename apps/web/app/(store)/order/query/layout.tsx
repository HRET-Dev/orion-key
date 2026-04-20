import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getSiteConfig } from "@/services/api-server"

export async function generateMetadata(): Promise<Metadata> {
  const config = await getSiteConfig().catch(() => null)
  const siteName = config?.site_name?.trim() || "Orion Key"

  return {
    title: `订单查询 - ${siteName}`,
    description: config?.site_description || config?.site_slogan || "",
    alternates: { canonical: "/order/query" },
    openGraph: {
      title: `订单查询 - ${siteName}`,
      description: config?.site_description || config?.site_slogan || "",
      url: "/order/query",
      type: "website",
    },
  }
}

export default function OrderQueryLayout({ children }: { children: ReactNode }) {
  return children
}
