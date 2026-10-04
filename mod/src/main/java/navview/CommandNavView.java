package navview;

import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;

public class CommandNavView extends CommandBase {
    @Override
    public String getCommandName () {
        return "navview";
    }

    @Override
    public String getCommandUsage (ICommandSender sender) {
        return "/navview [on|off|reconnect]";
    }

    @Override
    public int getRequiredPermissionLevel () {
        return 0;
    }

    @Override
    public void processCommand (ICommandSender sender, String[] args) {
        if (args.length == 0) {
            PathSnapshot snap = PathClient.current();
            int nodes = snap == null ? 0 : snap.nodes.size();
            PathClient.chat((NavView.enabled ? "on" : "off")
                + (PathClient.connected() ? ", connected" : ", not connected")
                + " to " + NavView.host + ":" + NavView.port
                + ", " + nodes + " nodes");
            return;
        }
        String action = args[0].toLowerCase();
        if (action.equals("on")) {
            NavView.enabled = true;
            PathClient.chat("overlay on");
        } else if (action.equals("off")) {
            NavView.enabled = false;
            PathClient.chat("overlay off");
        } else if (action.equals("reconnect")) {
            NavView.reconnect();
            PathClient.chat("reconnecting to " + NavView.host + ":" + NavView.port);
        } else {
            PathClient.chat("usage: /navview [on|off|reconnect]");
        }
    }
}
