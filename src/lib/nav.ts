export type NavItem = {
  label: string;
  href: string;
  description: string;
};

export const dashboardNav: NavItem[] = [
  {
    label: "Composer",
    href: "/email/composer",
    description: "Write and preview",
  },
  {
    label: "Queue",
    href: "/email/schedule",
    description: "Drafts and sending",
  },
  {
    label: "Sends",
    href: "/email/sends",
    description: "History and previews",
  },
  {
    label: "Monitor",
    href: "/email/monitor",
    description: "Scoped queue drain",
  },
  {
    label: "Analytics",
    href: "/email/analytics",
    description: "Delivery health",
  },
  {
    label: "Lists",
    href: "/lists",
    description: "Members and imports",
  },
  {
    label: "Users",
    href: "/users",
    description: "Admin access",
  },
];
