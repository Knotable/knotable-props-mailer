import { Role } from './role'

if Meteor.isClient

  loginFilter = ->
    Router.go "login" unless Meteor.userId()
    @next()

  adminFilter = ->
    Router.go "root" unless Meteor.user().role is Role.Admin
    @next()

  afterLogin = ->
    Router.go "email"  if Meteor.userId()

  emailSubscribe = ->
    if Meteor.userId()
      Meteor.subscribe "sentEmailEventsAndFiles"
    Tracker.autorun =>
      if @ready()
        event = EmailEvents.findOne user_id: Meteor.userId(), type: EmailHelperShared.DRAFT, {fields: _id: 1}
        Session.set "CURRENT_DRAFT_EVENT_ID", event._id if event

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
      template: "nav_tabs"
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

    @route "users",
      path: "/users"
      template: "users"
      layoutTemplate: "layout"
      onBeforeAction: [loginFilter, adminFilter]
      waitOn: -> Meteor.subscribe "users"
