#!/usr/bin/env python3
"""Applies the native configuration of the TypEase customer app to the platform
folders that `flutter create` generated.

The android/ and ios/ folders are NOT kept in this repository: they are created by
the Flutter tool (tool/bootstrap.sh), so they always match the installed Flutter
version. This script then adds the few things the app needs, from the documented
snippets next to this file:

  Android  AndroidManifest.xml   permissions, deep-link intent filters, <queries>,
                                 app label
           debug manifest        plain http for a local API (debug builds only)
           app/build.gradle(.kts) minimum SDK version
  iOS      Info.plist            camera / photo usage texts, URL scheme, local
                                 networking, display name
           Podfile, project.pbxproj, AppFrameworkInfo.plist
                                 minimum iOS version

The script is idempotent: every block it writes is wrapped in
`typease:begin <name>` / `typease:end <name>` markers and is replaced on the next
run. Anything it cannot find is reported as a WARNING with the manual step; it
never guesses.

Settings come from environment variables (all optional):

  APP_NAME            Name under the icon.                      default: TypEase
  DEEP_LINK_SCHEME    Custom URL scheme (must equal the         default: typease
                      DEEP_LINK_SCHEME dart-define).
  DEEP_LINK_HOSTS     Comma-separated https hosts for Android   default: (none)
                      App Links, e.g. "portal.example.ae".
  ANDROID_MIN_SDK     Minimum Android API level.                default: 23
  IOS_MIN_VERSION     Minimum iOS version.                      default: 13.0

Usage:  python3 tool/native/apply_native_config.py [project-dir]

Status: the script was exercised against copies of the manifest / plist / Gradle
templates of Flutter 3.24 written from memory, not against real `flutter create`
output (no Flutter SDK was available when it was written). Review its output once.
"""
from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

warnings: list[str] = []
changes: list[str] = []


def warn(message: str) -> None:
    warnings.append(message)
    print('  WARNING: ' + message)


def note(message: str) -> None:
    changes.append(message)
    print('  ' + message)


def read(path: str) -> str:
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def write(path: str, content: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(content)


def snippet(relative: str) -> str:
    return read(os.path.join(HERE, relative)).rstrip('\n')


def setting(name: str, default: str) -> str:
    value = os.environ.get(name, '').strip()
    return value or default


def strip_block(text: str, name: str) -> str:
    """Removes an earlier `typease:begin name` ... `typease:end name` block (with its line breaks)."""
    pattern = re.compile(
        r'[ \t]*<!-- typease:begin ' + re.escape(name) + r'\b.*?<!-- typease:end ' + re.escape(name) + r' -->[ \t]*\n?',
        re.S,
    )
    return pattern.sub('', text)


def version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r'\d+', value))


# --------------------------------------------------------------------------- Android

def patch_android_manifest(root: str, app_name: str, scheme: str, hosts: list[str]) -> None:
    path = os.path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
    if not os.path.isfile(path):
        warn('android/app/src/main/AndroidManifest.xml not found - run `flutter create` first (tool/bootstrap.sh).')
        return
    text = read(path)
    original = text
    for name in ('permissions', 'activity', 'queries'):
        text = strip_block(text, name)

    # 1. permissions: directly after the opening <manifest ...> tag
    opening = re.search(r'<manifest\b[^>]*>', text)
    if opening is None:
        warn('AndroidManifest.xml: no <manifest> tag found; add tool/native/android/manifest_permissions.xml by hand.')
    else:
        block = snippet('android/manifest_permissions.xml')
        text = text[:opening.end()] + '\n' + block + text[opening.end():]

    # 2. deep links: inside the launcher activity, before its closing tag
    filters = '\n'.join(snippet('android/manifest_app_link_filter.xml').replace('@HOST@', host) for host in hosts)
    activity_block = snippet('android/manifest_activity.xml').replace('@DEEP_LINK_SCHEME@', scheme)
    if filters:
        activity_block = activity_block.replace('@APP_LINK_FILTERS@', filters)
    else:
        activity_block = activity_block.replace('@APP_LINK_FILTERS@\n', '')
    closing_activity = text.find('</activity>')
    if closing_activity < 0:
        warn('AndroidManifest.xml: no </activity> found; add tool/native/android/manifest_activity.xml to the main activity by hand.')
    else:
        line_start = text.rfind('\n', 0, closing_activity) + 1
        text = text[:line_start] + activity_block + '\n' + text[line_start:]

    # 3. package visibility: before </manifest>
    closing_manifest = text.rfind('</manifest>')
    if closing_manifest < 0:
        warn('AndroidManifest.xml: no </manifest> found; add tool/native/android/manifest_queries.xml by hand.')
    else:
        text = text[:closing_manifest] + snippet('android/manifest_queries.xml') + '\n' + text[closing_manifest:]

    # 4. name under the icon
    application = re.search(r'<application\b[^>]*>', text, re.S)
    if application is None:
        warn('AndroidManifest.xml: no <application> tag found; set android:label by hand.')
    else:
        tag = application.group(0)
        escaped = app_name.replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;')
        if re.search(r'android:label="[^"]*"', tag):
            new_tag = re.sub(r'android:label="[^"]*"', lambda _: 'android:label="%s"' % escaped, tag, count=1)
        else:
            new_tag = tag.replace('<application', '<application\n        android:label="%s"' % escaped, 1)
        text = text[:application.start()] + new_tag + text[application.end():]

    if text != original:
        write(path, text)
        note('android: AndroidManifest.xml updated (permissions, scheme "%s"%s, queries, label "%s")'
             % (scheme, ', app links for ' + ', '.join(hosts) if hosts else '', app_name))
    else:
        note('android: AndroidManifest.xml already up to date')


def patch_android_debug_manifest(root: str) -> None:
    path = os.path.join(root, 'android', 'app', 'src', 'debug', 'AndroidManifest.xml')
    if not os.path.isfile(path):
        warn('android/app/src/debug/AndroidManifest.xml not found; a debug build may not reach a plain-http local API '
             '(add tool/native/android/debug_manifest_application.xml by hand).')
        return
    text = read(path)
    original = text
    text = strip_block(text, 'debug-cleartext')
    closing = text.rfind('</manifest>')
    if closing < 0:
        warn('debug AndroidManifest.xml: no </manifest> found.')
        return
    text = text[:closing] + snippet('android/debug_manifest_application.xml') + '\n' + text[closing:]
    if text != original:
        write(path, text)
        note('android: debug manifest allows plain http (debug builds only)')
    else:
        note('android: debug manifest already up to date')


def patch_android_min_sdk(root: str, min_sdk: str) -> None:
    groovy = os.path.join(root, 'android', 'app', 'build.gradle')
    kotlin = os.path.join(root, 'android', 'app', 'build.gradle.kts')
    path = kotlin if os.path.isfile(kotlin) else groovy
    if not os.path.isfile(path):
        warn('android/app/build.gradle(.kts) not found; set minSdk to %s by hand.' % min_sdk)
        return
    is_kotlin = path.endswith('.kts')
    text = read(path)
    # Never lower the value: a newer Flutter may already require more.
    expression = ('maxOf(flutter.minSdkVersion, %s)' if is_kotlin else 'Math.max(flutter.minSdkVersion, %s)') % min_sdk
    pattern = re.compile(
        r'^(?P<indent>[ \t]*)(?P<name>minSdk|minSdkVersion)(?P<sep>\s*=\s*|\s+)'
        r'(?P<value>flutter\.minSdkVersion|(?:maxOf|Math\.max)\(flutter\.minSdkVersion,\s*\d+\)|\d+)[ \t]*$',
        re.M,
    )
    match = pattern.search(text)
    if match is None:
        warn('%s: no minSdk line recognised; set the minimum SDK to %s by hand (flutter_secure_storage needs 23).'
             % (os.path.relpath(path, root), min_sdk))
        return
    value = match.group('value')
    if value.isdigit():
        if int(value) >= int(min_sdk):
            note('android: minSdk is %s (kept)' % value)
            return
        replacement = min_sdk
    else:
        replacement = expression
    new_line = '%s%s%s%s' % (match.group('indent'), match.group('name'), match.group('sep'), replacement)
    if new_line == match.group(0).rstrip():
        note('android: minSdk already set (%s)' % replacement)
        return
    text = text[:match.start()] + new_line + text[match.end():]
    write(path, text)
    note('android: minSdk set to %s in %s' % (replacement, os.path.relpath(path, root)))


# --------------------------------------------------------------------------- iOS

def top_level_entries(plist_fragment: str) -> list[tuple[str, str]]:
    """Splits the body of the outer <dict> into (key, 'key + value' text) pairs."""
    start = plist_fragment.index('<dict>') + len('<dict>')
    end = plist_fragment.rindex('</dict>')
    body = plist_fragment[start:end]
    # Comments in the snippet are documentation only; they are not copied.
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    entries: list[tuple[str, str]] = []
    position = 0
    key_pattern = re.compile(r'<key>([^<]+)</key>')
    while True:
        key = key_pattern.search(body, position)
        if key is None:
            break
        value_start = key.end()
        value_end = end_of_value(body, value_start)
        entries.append((key.group(1), body[key.start():value_end].strip()))
        position = value_end
    return entries


def end_of_value(body: str, position: int) -> int:
    """Index just after the plist value that starts at or after [position]."""
    match = re.compile(r'\s*<(\w+)(\s*/)?>').match(body, position)
    if match is None:
        raise ValueError('plist snippet: value expected after key')
    tag = match.group(1)
    if match.group(2):  # <true/>, <false/>
        return match.end()
    depth = 0
    for token in re.finditer(r'<(/?)%s\b[^>]*?(/?)>' % re.escape(tag), body[match.start():]):
        if token.group(2):
            continue
        depth += -1 if token.group(1) else 1
        if depth == 0:
            return match.start() + token.end()
    raise ValueError('plist snippet: unbalanced <%s>' % tag)


def patch_ios_info_plist(root: str, app_name: str, scheme: str) -> None:
    path = os.path.join(root, 'ios', 'Runner', 'Info.plist')
    if not os.path.isfile(path):
        warn('ios/Runner/Info.plist not found - run `flutter create` first (tool/bootstrap.sh).')
        return
    text = read(path)
    original = text
    fragment = (snippet('ios/Info.plist.additions.xml')
                .replace('@DEEP_LINK_SCHEME@', scheme)
                .replace('@BUNDLE_URL_NAME@', '$(PRODUCT_BUNDLE_IDENTIFIER)'))
    closing = text.rfind('</dict>')
    if closing < 0:
        warn('Info.plist: no closing </dict>; add the keys of tool/native/ios/Info.plist.additions.xml by hand.')
        return
    line_start = text.rfind('\n', 0, closing) + 1
    additions = []
    for key, entry in top_level_entries(fragment):
        if '<key>%s</key>' % key in text:
            if key == 'CFBundleURLTypes' and ('<string>%s</string>' % scheme) not in text:
                # A different scheme was configured earlier. When the entry has exactly one
                # scheme (as this script writes it) it is replaced; anything else is left alone.
                single = re.compile(r'(<key>CFBundleURLSchemes</key>\s*<array>\s*<string>)[^<]*(</string>\s*</array>)')
                if len(single.findall(text)) == 1:
                    text = single.sub(lambda m: m.group(1) + scheme + m.group(2), text, count=1)
                    print('  ios: URL scheme in Info.plist changed to "%s"' % scheme)
                else:
                    warn('Info.plist already has CFBundleURLTypes without the scheme "%s"; add it by hand.' % scheme)
            else:
                print('  ios: Info.plist already has %s (kept)' % key)
            continue
        indented = '\n'.join('\t' + line.strip('\n') if line.strip() else line for line in reindent(entry))
        additions.append(indented)
    if additions:
        text = text[:line_start] + '\n'.join(additions) + '\n' + text[line_start:]

    # Name under the icon.
    escaped = app_name.replace('&', '&amp;').replace('<', '&lt;')
    display = re.compile(r'(<key>CFBundleDisplayName</key>\s*<string>)([^<]*)(</string>)')
    if display.search(text):
        text = display.sub(lambda m: m.group(1) + escaped + m.group(3), text, count=1)
    else:
        warn('Info.plist: CFBundleDisplayName not found; set the app name in Xcode.')

    if text != original:
        write(path, text)
        note('ios: Info.plist updated (usage texts, scheme "%s", display name "%s")' % (scheme, app_name))
    else:
        note('ios: Info.plist already up to date')


def reindent(entry: str) -> list[str]:
    """Normalises the indentation of a copied plist entry to tabs relative to its key."""
    lines = entry.split('\n')
    depth = 0
    out = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        closes = len(re.findall(r'^</(dict|array)>', line))
        depth -= closes
        out.append('\t' * max(depth, 0) + line)
        opens = len(re.findall(r'<(dict|array)>', line)) - len(re.findall(r'</(dict|array)>', line)) + closes
        depth += opens
    return out


def patch_ios_min_version(root: str, minimum: str) -> None:
    wanted = version_tuple(minimum)

    podfile = os.path.join(root, 'ios', 'Podfile')
    if os.path.isfile(podfile):
        text = read(podfile)
        pattern = re.compile(r"^[ \t]*#?[ \t]*platform :ios, '([0-9.]+)'[ \t]*$", re.M)
        match = pattern.search(text)
        if match is None:
            warn("ios/Podfile: no `platform :ios` line; add `platform :ios, '%s'` at the top." % minimum)
        else:
            commented = match.group(0).lstrip().startswith('#')
            if commented or version_tuple(match.group(1)) < wanted:
                version = minimum if version_tuple(match.group(1)) < wanted else match.group(1)
                text = text[:match.start()] + "platform :ios, '%s'" % version + text[match.end():]
                write(podfile, text)
                note("ios: Podfile platform set to iOS %s" % version)
            else:
                note('ios: Podfile platform is iOS %s (kept)' % match.group(1))
    else:
        print('  ios: no Podfile yet (it is created by `flutter pub get` / the first iOS build on macOS). '
              'Run this script again afterwards.')

    project = os.path.join(root, 'ios', 'Runner.xcodeproj', 'project.pbxproj')
    if os.path.isfile(project):
        text = read(project)
        count = 0

        def raise_target(match: re.Match) -> str:
            nonlocal count
            if version_tuple(match.group(1)) < wanted:
                count += 1
                return 'IPHONEOS_DEPLOYMENT_TARGET = %s;' % minimum
            return match.group(0)

        new_text = re.sub(r'IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);', raise_target, text)
        if count:
            write(project, new_text)
            note('ios: deployment target raised to %s in project.pbxproj (%d build configurations)' % (minimum, count))
        elif 'IPHONEOS_DEPLOYMENT_TARGET' in text:
            note('ios: deployment target already >= %s' % minimum)
        else:
            warn('project.pbxproj: IPHONEOS_DEPLOYMENT_TARGET not found; set the deployment target to %s in Xcode.' % minimum)
    else:
        warn('ios/Runner.xcodeproj/project.pbxproj not found; set the deployment target to %s in Xcode.' % minimum)

    framework = os.path.join(root, 'ios', 'Flutter', 'AppFrameworkInfo.plist')
    if os.path.isfile(framework):
        text = read(framework)
        pattern = re.compile(r'(<key>MinimumOSVersion</key>\s*<string>)([0-9.]+)(</string>)')
        match = pattern.search(text)
        if match is not None and version_tuple(match.group(2)) < wanted:
            text = pattern.sub(lambda m: m.group(1) + minimum + m.group(3), text, count=1)
            write(framework, text)
            note('ios: AppFrameworkInfo.plist MinimumOSVersion set to %s' % minimum)


# --------------------------------------------------------------------------- main

def main() -> int:
    root = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath(os.path.join(HERE, '..', '..'))
    app_name = setting('APP_NAME', 'TypEase')
    scheme = setting('DEEP_LINK_SCHEME', 'typease').lower()
    hosts = [host.strip().lower() for host in os.environ.get('DEEP_LINK_HOSTS', '').split(',') if host.strip()]
    min_sdk = setting('ANDROID_MIN_SDK', '23')
    ios_min = setting('IOS_MIN_VERSION', '13.0')

    if not re.fullmatch(r'[a-z][a-z0-9+.-]*', scheme):
        print('ERROR: DEEP_LINK_SCHEME "%s" is not a valid URL scheme.' % scheme)
        return 2
    for host in hosts:
        if not re.fullmatch(r'[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+', host):
            print('ERROR: DEEP_LINK_HOSTS entry "%s" is not a host name.' % host)
            return 2
    if not min_sdk.isdigit():
        print('ERROR: ANDROID_MIN_SDK must be a number.')
        return 2
    if not re.fullmatch(r'\d+(\.\d+){0,2}', ios_min):
        print('ERROR: IOS_MIN_VERSION must look like 13.0.')
        return 2

    print('Applying native configuration in ' + root)
    if os.path.isdir(os.path.join(root, 'android')):
        patch_android_manifest(root, app_name, scheme, hosts)
        patch_android_debug_manifest(root)
        patch_android_min_sdk(root, min_sdk)
    else:
        warn('android/ does not exist - run tool/bootstrap.sh (flutter create) first.')
    if os.path.isdir(os.path.join(root, 'ios')):
        patch_ios_info_plist(root, app_name, scheme)
        patch_ios_min_version(root, ios_min)
    else:
        warn('ios/ does not exist - run tool/bootstrap.sh (flutter create) first.')

    print('')
    print('Not done by this script (see tool/native/README.md):')
    print('  - iOS Universal Links (Associated Domains) and push notifications need a capability and a')
    print('    signing team, which are set in Xcode.')
    print('  - Launcher icons and the launch screen.')
    print('  - Release signing (Android keystore, iOS provisioning).')
    if warnings:
        print('')
        print('%d warning(s) - the steps above marked WARNING must be done by hand.' % len(warnings))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
