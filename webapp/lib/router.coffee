if Meteor.isClient

  loginFilter = ->
    Router.go "login"  unless Meteor.userId()
    @next()

  afterLogin = ->
    Router.go "email"  if Meteor.userId()

  emailSubscribe = ->
    if Meteor.userId()
      Meteor.subscribe "sentEmailEventsAndFiles"
      EmailViewerHelper.findAndCreateNotExistingEmailEvent()

  mailingListSubscribe = ->
    if Meteor.userId()
      Meteor.subscribe "mailingList"



  Router.map ->
    @route "root",
      path: "/"
      template: "login"
      layoutTemplate: "layout"
      onBeforeAction: [loginFilter]
      onAfterAction: [afterLogin]

    @route "login",
      path: "/login"
      template: "login"
      layoutTemplate: "layout"
      onAfterAction: [afterLogin]

    @route "email",
      path: "/email"
      template: "email_container"
      layoutTemplate: "layout"
      onBeforeAction: [loginFilter]
      onAfterAction: [emailSubscribe]
      waitOn: -> Meteor.subscribe "emailEventsAndFiles"

    @route "list",
      path: "/list"
      template: "mailing_list_container"
      layoutTemplate: "layout"
      onBeforeAction: [loginFilter]
      onAfterAction: [mailingListSubscribe]
