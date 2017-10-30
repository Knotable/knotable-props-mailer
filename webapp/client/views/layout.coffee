loginFn = ->
  Meteor.loginWithGithub
    requestPermissions: [
      "user"
      "repo"
      "read:org"
    ]
  , (err) ->
    return unless err
    console.log err
    showErrorBootstrapGrowl err.reason



Template.user_loggedout.events "click #login": loginFn



Template.user_loggedin.events "click #logout": ->
  Meteor.logout (err) ->
    console.log err



Template.layout.helpers
  selected_domain: ->
    Session.get 'selected_domain'



Template.layout.events
  'click a.admin-domain' : (e) ->
    UiHelper.showLoading()
    Session.set 'selected_domain',$(e.target).attr('data-domain')



  'click a.email-tab' : (e) ->
    Router.go("/email")



  'click a.list-tab' : (e) ->
    Router.go("/list")
