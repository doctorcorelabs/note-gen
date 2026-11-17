'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import {
  BugIcon,
  CircleAlertIcon,
  ClipboardIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react'
import { platform } from '@/lib/platform'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const GITHUB_BUG_REPORT_URL = 'https://github.com/codexu/note-gen/issues/new'

interface TabContentErrorBoundaryProps {
  children: ReactNode
  tabName: string
  onClose: () => void
}

interface TabContentErrorBoundaryState {
  error: Error | null
  copied: boolean
  actionError: string
}

export class TabContentErrorBoundary extends Component<
  TabContentErrorBoundaryProps,
  TabContentErrorBoundaryState
> {
  state: TabContentErrorBoundaryState = {
    error: null,
    copied: false,
    actionError: '',
  }

  static getDerivedStateFromError(error: Error): Partial<TabContentErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('标签页内容渲染失败:', error, info.componentStack)
  }

  private getErrorDetails() {
    const { error } = this.state
    return [
      `Tab: ${this.props.tabName}`,
      `Error: ${error?.message || 'Unknown error'}`,
      `Time: ${new Date().toISOString()}`,
      error?.stack ? `\n${error.stack}` : '',
    ].filter(Boolean).join('\n')
  }

  private retry = () => {
    this.setState({
      error: null,
      copied: false,
      actionError: '',
    })
  }

  private copyErrorDetails = async () => {
    try {
      await navigator.clipboard.writeText(this.getErrorDetails())
      this.setState({ copied: true, actionError: '' })
      window.setTimeout(() => this.setState({ copied: false }), 2000)
    } catch (error) {
      console.error('复制标签页错误信息失败:', error)
      this.setState({ actionError: 'Unable to copy the error details. Please check clipboard permissions.' })
    }
  }

  private reportGitHubIssue = async () => {
    let diagnosticsCopied = false
    try {
      await navigator.clipboard.writeText(this.getErrorDetails())
      diagnosticsCopied = true
    } catch (error) {
      console.error('复制 GitHub 反馈信息失败:', error)
    }

    try {
      const issueUrl = new URL(GITHUB_BUG_REPORT_URL)
      issueUrl.searchParams.set('template', 'bug_report.yml')
      issueUrl.searchParams.set('title', '[bug] Tab entered error isolation mode')
      await platform.opener.openUrl(issueUrl)
      this.setState({
        actionError: diagnosticsCopied
          ? ''
          : 'GitHub is open, but copying the error details failed. Please fill in the error log manually.',
      })
    } catch (error) {
      console.error('打开 GitHub 反馈页面失败:', error)
      this.setState({ actionError: 'Unable to open the GitHub feedback page. Please check your network or browser settings.' })
    }
  }

  render() {
    const { children, onClose } = this.props
    const { actionError, copied, error } = this.state

    if (!error) return children

    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>The current tab encountered an error</CardTitle>
            <CardDescription>
              Only this tab has stopped displaying. The sidebar, other tabs, and settings remain usable.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Error details</AlertTitle>
              <AlertDescription className="max-h-24 overflow-auto break-words font-mono text-xs">
                {error.message || 'Unknown error'}
              </AlertDescription>
            </Alert>
            {actionError ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>Action failed</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-wrap justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button onClick={this.retry}>
                <RefreshCwIcon data-icon="inline-start" />
                Retry this tab
              </Button>
              <Button variant="outline" onClick={onClose}>
                <XIcon data-icon="inline-start" />
                Close this tab
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => void this.copyErrorDetails()}>
                <ClipboardIcon data-icon="inline-start" />
                {copied ? 'Copied' : 'Copy error details'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void this.reportGitHubIssue()}>
                <BugIcon data-icon="inline-start" />
                Report a GitHub Issue
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    )
  }
}
