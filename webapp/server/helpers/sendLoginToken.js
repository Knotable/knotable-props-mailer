import { Accounts } from "meteor/accounts-base";
import { defaultDomainConfig } from "../mailgunDomains";

Accounts.emailTemplates.sendLoginToken = {
  from: () => `Kmail <noreply@${defaultDomainConfig.domain}>`,

  subject: (_, __, { template }) => {
    if (template && Handlebars.templates[template.name]) {
      return template.subject;
    }

    throw new Error(
      `Not found "${
        template?.name || "default"
      }" template defined for the sendLoginToken email template handler`
    );
  },

  html(_, url, { template, searchParams = {} }) {
    if (template && Handlebars.templates[template.name]) {
      const loginUrl = new URL(url);
      loginUrl.pathname = "/loginWithToken";

      Object.entries(searchParams).forEach(([key, value]) => {
        loginUrl.searchParams.append(key, value);
      });

      return Handlebars.templates[template.name]({
        loginUrl,
        ...template.props,
      });
    }

    throw new Error(
      `Not found "${
        template?.name || "default"
      }" template defined for the sendLoginToken email template handler`
    );
  },
};
