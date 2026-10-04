package navview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.EnumChatFormatting;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

// Reads newline-delimited path snapshots from the bot's localhost debug server.
final class PathClient {
    private volatile PathSnapshot snapshot = PathSnapshot.EMPTY;
    private volatile boolean connected;
    private volatile boolean running = true;
    private volatile Socket socket;
    private Thread thread;

    void start () {
        thread = new Thread(this::loop, "navview");
        thread.setDaemon(true);
        thread.start();
    }

    void reconnect () {
        Socket open = socket;
        if (open != null) {
            try {
                open.close();
            } catch (Exception ignored) {
            }
        }
    }

    static PathSnapshot current () {
        PathClient client = NavView.client();
        return client == null ? PathSnapshot.EMPTY : client.snapshot;
    }

    static boolean connected () {
        PathClient client = NavView.client();
        return client != null && client.connected;
    }

    static void chat (String text) {
        Minecraft mc = Minecraft.getMinecraft();
        if (mc == null || mc.thePlayer == null) return;
        mc.thePlayer.addChatMessage(new ChatComponentText(
            EnumChatFormatting.AQUA + "[navview] " + EnumChatFormatting.GRAY + text));
    }

    private void loop () {
        while (running) {
            if (!isLocal(NavView.host)) {
                chat("refusing " + NavView.host + " (localhost only)");
                sleep(5000);
                continue;
            }
            try {
                Socket next = new Socket();
                next.connect(new InetSocketAddress(NavView.host, NavView.port), 2000);
                next.setTcpNoDelay(true);
                socket = next;
                connected = true;
                chat("connected to " + NavView.host + ":" + NavView.port);
                BufferedReader reader = new BufferedReader(new InputStreamReader(next.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while ((line = reader.readLine()) != null) {
                    PathSnapshot parsed = parse(line);
                    if (parsed != null) snapshot = parsed;
                }
            } catch (Exception ignored) {
            } finally {
                boolean was = connected;
                connected = false;
                snapshot = PathSnapshot.EMPTY;
                Socket open = socket;
                socket = null;
                if (open != null) {
                    try {
                        open.close();
                    } catch (Exception ignored) {
                    }
                }
                if (was) chat("disconnected, retrying");
            }
            sleep(1500);
        }
    }

    private static boolean isLocal (String host) {
        if (host == null) return false;
        String name = host.trim().toLowerCase();
        if (name.equals("localhost") || name.equals("127.0.0.1") || name.equals("::1")) return true;
        try {
            InetAddress address = InetAddress.getByName(name);
            return address.isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }

    private static PathSnapshot parse (String line) {
        if (line == null || line.isEmpty()) return null;
        try {
            JsonObject obj = new JsonParser().parse(line).getAsJsonObject();
            if (!obj.has("nodes")) return null;
            JsonArray array = obj.getAsJsonArray("nodes");
            List<PathSnapshot.Node> nodes = new ArrayList<PathSnapshot.Node>(array.size());
            for (JsonElement element : array) {
                JsonObject n = element.getAsJsonObject();
                nodes.add(new PathSnapshot.Node(
                    n.has("i") ? n.get("i").getAsInt() : nodes.size(),
                    n.get("x").getAsDouble(),
                    n.get("y").getAsDouble(),
                    n.get("z").getAsDouble(),
                    n.has("kind") ? n.get("kind").getAsString() : "walk",
                    n.has("anchor") && n.get("anchor").getAsBoolean()
                ));
            }
            return new PathSnapshot(
                obj.has("active") && obj.get("active").getAsBoolean(),
                obj.has("status") ? obj.get("status").getAsString() : "idle",
                obj.has("cursor") ? obj.get("cursor").getAsInt() : 0,
                vec(obj.get("goal")),
                vec(obj.get("bot")),
                nodes
            );
        } catch (Exception e) {
            return null;
        }
    }

    private static double[] vec (JsonElement element) {
        if (element == null || element.isJsonNull()) return null;
        JsonObject obj = element.getAsJsonObject();
        return new double[] { obj.get("x").getAsDouble(), obj.get("y").getAsDouble(), obj.get("z").getAsDouble() };
    }

    private static void sleep (long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
