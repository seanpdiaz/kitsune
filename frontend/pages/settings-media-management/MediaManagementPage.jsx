import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, TextField, NumberField, SelectField } from '../../components/SettingsFormFields.jsx';
import RootFolders from '../../components/RootFolders.jsx';

// React port of settings-media-management.html's page logic — see README's
// "React migration" section, Batch 8. Naming/File Management/Importing are
// all backed by the generic useSettingsForm('media-management', ...) hook
// (the same one General/UI use); Root Folders is its own component since it
// isn't part of that one settings object (backed by /api/settings-items/
// root-folders instead).
const DEFAULTS = {
  renameEpisodesToggle: true,
  'mm-1': '{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]',
  'mm-2': '{Series Title} - {absolute:000} - {Episode Title} [{Quality Full}][{MediaInfo VideoBitDepth}bit]',
  'mm-3': '{Series Title} ({Series Year})',
  'mm-4': 'Season {season:00}',
  'mm-5': true,
  'mm-6': 'Prefer and upgrade',
  'mm-7': true,
  'mm-8': true,
  setPermissionsToggle: false,
  'mm-10': '755',
  'mm-11': '644',
  chownUser: '',
  chownGroup: '',
  'mm-12': false,
  'mm-13': 100,
  'mm-14': true,
  'mm-15': 'srt, nfo, ass',
};

export default function MediaManagementPage() {
  const { values: v, setField } = useSettingsForm('media-management', DEFAULTS);
  const namingDisabled = !v.renameEpisodesToggle;
  const permissionsDisabled = !v.setPermissionsToggle;

  return (
    <>
      <p className="settings-subtitle">Naming, folders, and file handling behavior.</p>

      <SettingsCard title="Episode Naming" desc="Controls how downloaded episodes are renamed and organized on disk.">
        <FormRow name="Rename Episodes" desc="Kitsune renames episodes on import to match the format below.">
          <ToggleField id="renameEpisodesToggle" checked={v.renameEpisodesToggle} onChange={(val) => setField('renameEpisodesToggle', val)} />
        </FormRow>
        <FormRow name="Standard Episode Format" desc="For series numbered by season and episode." className={`naming-field${namingDisabled ? ' is-disabled' : ''}`}>
          <div style={{ width: '100%' }}>
            <TextField id="mm-1" wide value={v['mm-1']} onChange={(val) => setField('mm-1', val)} />
            <p className="format-preview">Frieren - S02E22 - A Parting Gift [WEBDL-1080p].mkv</p>
          </div>
        </FormRow>
        <FormRow name="Anime Episode Format" desc="For series numbered by absolute episode count." className={`naming-field${namingDisabled ? ' is-disabled' : ''}`}>
          <div style={{ width: '100%' }}>
            <TextField id="mm-2" wide value={v['mm-2']} onChange={(val) => setField('mm-2', val)} />
            <p className="format-preview">Chainsaw Man - 011 - Rescue [WEBDL-1080p][10bit].mkv</p>
          </div>
        </FormRow>
        <FormRow name="Series Folder Format" desc="Root-level folder created for each series." className={`naming-field${namingDisabled ? ' is-disabled' : ''}`}>
          <TextField id="mm-3" value={v['mm-3']} onChange={(val) => setField('mm-3', val)} />
        </FormRow>
        <FormRow name="Season Folder Format" desc="Subfolder created for each season within a series." className={`naming-field${namingDisabled ? ' is-disabled' : ''}`}>
          <TextField id="mm-4" value={v['mm-4']} onChange={(val) => setField('mm-4', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Root Folders" desc="Default locations Kitsune can import series into.">
        <RootFolders />
      </SettingsCard>

      <SettingsCard title="File Management" desc="How Kitsune treats files during import and on disk.">
        <FormRow name="Unmonitor Deleted Episodes" desc="Episodes deleted from disk are automatically unmonitored.">
          <ToggleField id="mm-5" checked={v['mm-5']} onChange={(val) => setField('mm-5', val)} />
        </FormRow>
        <FormRow name="Propers and Repacks" desc="Whether to prefer a Proper/Repack release over the original.">
          <SelectField
            id="mm-6" value={v['mm-6']} onChange={(val) => setField('mm-6', val)}
            options={['Prefer and upgrade', 'Do not upgrade automatically', 'Do not prefer']}
          />
        </FormRow>
        <FormRow name="Analyze Video Files" desc="Extract video/audio codec, resolution, and language info on import.">
          <ToggleField id="mm-7" checked={v['mm-7']} onChange={(val) => setField('mm-7', val)} />
        </FormRow>
        <FormRow name="Replace Illegal Characters" desc="Replace characters not allowed on the target filesystem instead of removing them.">
          <ToggleField id="mm-8" checked={v['mm-8']} onChange={(val) => setField('mm-8', val)} />
        </FormRow>
        <FormRow name="Set Permissions" desc="Set Unix file/folder permissions on import.">
          <ToggleField id="setPermissionsToggle" checked={v.setPermissionsToggle} onChange={(val) => setField('setPermissionsToggle', val)} />
        </FormRow>
        <FormRow name="Folder Chmod" desc="Octal permissions applied to created folders." className={`permissions-field${permissionsDisabled ? ' is-disabled' : ''}`}>
          <TextField id="mm-10" value={v['mm-10']} onChange={(val) => setField('mm-10', val)} />
        </FormRow>
        <FormRow name="File Chmod" desc="Octal permissions applied to imported files." className={`permissions-field${permissionsDisabled ? ' is-disabled' : ''}`}>
          <TextField id="mm-11" value={v['mm-11']} onChange={(val) => setField('mm-11', val)} />
        </FormRow>
        <FormRow name="chown User" desc="Owner to set on imported files/folders. Leave blank to leave the owner unchanged. Accepts a username or numeric uid — usually requires Kitsune to be running as root to actually take effect." className={`permissions-field${permissionsDisabled ? ' is-disabled' : ''}`}>
          <TextField id="chownUser" value={v.chownUser} onChange={(val) => setField('chownUser', val)} />
        </FormRow>
        <FormRow name="chown Group" desc="Group to set on imported files/folders. Leave blank to leave the group unchanged. Accepts a group name or numeric gid." className={`permissions-field${permissionsDisabled ? ' is-disabled' : ''}`}>
          <TextField id="chownGroup" value={v.chownGroup} onChange={(val) => setField('chownGroup', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Importing" desc="Behavior when Kitsune imports completed downloads.">
        <FormRow name="Skip Free Space Check" desc="Skip the free space check before importing.">
          <ToggleField id="mm-12" checked={v['mm-12']} onChange={(val) => setField('mm-12', val)} />
        </FormRow>
        <FormRow name="Minimum Free Space" desc="Minimum free disk space (MB) required to import.">
          <NumberField id="mm-13" value={v['mm-13']} onChange={(val) => setField('mm-13', val)} />
        </FormRow>
        <FormRow name="Use Hardlinks Instead of Copy" desc="Try to hardlink files instead of copying when possible.">
          <ToggleField id="mm-14" checked={v['mm-14']} onChange={(val) => setField('mm-14', val)} />
        </FormRow>
        <FormRow name="Import Extra Files" desc="Extra file extensions to import alongside episodes.">
          <TextField id="mm-15" value={v['mm-15']} onChange={(val) => setField('mm-15', val)} />
        </FormRow>
      </SettingsCard>
    </>
  );
}
